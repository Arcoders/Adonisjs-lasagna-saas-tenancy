import { test } from '@japa/runner'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { IsthmusGuardTrippedPayload } from '@adonisjs-lasagna/saas-tenancy/types'
import { ISTHMUS_BUDGETS } from '@adonisjs-lasagna/saas-tenancy/sdk'
import {
  AI_GUARD_REJECTIONS_METRIC,
  emitAiGuardEvent,
  setAiGuardMetricSink,
  snapshotAiGuardCounters,
  __resetAiGuardCounters,
  __resetAiGuardRateLimit,
  __setAiGuardDispatcherForTests,
} from '../../../../src/isthmus/ai_guard_audit.js'
import { AI_GUARD_REGISTRY, type AiGuardId } from '../../../../src/isthmus/ai_guard_registry.js'
import { resolveTenantProviderSelection } from '../../../../src/services/tenant_provider_selection.js'
import {
  authorizeAiAccess,
  authorizeIngestion,
  resolveRetrievalScope,
} from '../../../../src/gateway/access_gate.js'
import { validateIdempotencyKeyHeader } from '../../../../src/gateway/idempotency.js'
import {
  assertActionAllowed,
  assertActiveToolScope,
  authorizeToolScope,
  resolveKnownTool,
} from '../../../../src/gateway/tool_gate.js'
import { validateToolInput } from '../../../../src/gateway/tool_input.js'
import { buildToolLoopProducer } from '../../../../src/gateway/tool_loop.js'
import { assertAiMountAllowed } from '../../../../src/routes/mount_gate.js'
import AIProviderRegistry from '../../../../src/services/ai_provider_registry.js'
import AiRateLimiter from '../../../../src/services/ai_rate_limiter.js'
import ClaudeProvider from '../../../../src/providers/claude_provider.js'
import { assertAiConfig } from '../../../../src/validate_config.js'
import MockAIProvider from '../../../../src/testing/mock_ai_provider.js'
import VectorStoreService from '../../../../src/services/vector_store_service.js'
import AiAuditWriter from '../../../../src/services/ai_audit_writer.js'
import ConversationMemoryService from '../../../../src/services/conversation_memory_service.js'
import { enforceChatResidency } from '../../../../src/services/residency_gate.js'
import AiComplianceService from '../../../../src/services/ai_compliance_service.js'
import { fakeVectorEnv } from '../../../helpers/fake_vector_db.js'
import { fakeAuditEnv, sampleAuditRow } from '../../../helpers/fake_audit_db.js'
import type { AiConfig } from '../../../../src/define_config.js'

/** A minimal embedding chunk for the vector-store guard recipes. */
const embChunk = (embedding: number[], contentHash = 'h') => ({
  content: 'c',
  contentHash,
  metadata: {},
  model: 'm',
  actor: null,
  embedding,
})
const storedRow = { id: 'x', content_hash: 'h' }

/** A memory service for the session-guard recipe; mint/resolve never touch Redis, so the store throws if reached. */
const memoryForMatrix = () =>
  new ConversationMemoryService({
    getRedis: async () => {
      throw new Error('the session guard must not reach Redis')
    },
    macKey: Buffer.alloc(32, 7),
    encryptMemory: (p) => p,
    decryptMemory: (c) => c,
    config: { maxTurns: 10 },
  })

/**
 * The registry-driven AI guard emission matrix, mirroring the kernel's. Every
 * registered guard must, when tripped, emit its own event (exactly once) with
 * a payload that mirrors its registry entry, and must NOT emit on a happy
 * input. Completeness is pinned BOTH ways so a new guard cannot ship without a
 * behavioral test: the matrix is typed `Record<AiGuardId, Recipe>` (a new
 * registry entry is a COMPILE error here until it gets a recipe), and every
 * matrix key must be a real registry id.
 */

const tenant = { id: 'tenant-1' } as unknown as TenantModelContract
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

interface TripRecipe {
  /** Trips the guard; sync or async. Throws the guard's own exception, unless `expectThrow` is null. */
  trip: () => unknown | Promise<unknown>
  /**
   * The original (unchanged) exception's message must match this. `null` marks a
   * SIGNAL guard that emits WITHOUT throwing (the auto-purge listener is
   * non-throwing by design): the trip must NOT throw, but must still emit.
   */
  expectThrow: RegExp | null
  /** A happy input that must NOT emit. */
  happy: () => unknown | Promise<unknown>
}

/** A minimal AiComplianceService for the auto-purge signal recipe; only the epoch dep matters (a failed gate emits). */
function complianceForMatrix(epochFails: boolean): AiComplianceService {
  return new AiComplianceService({
    memory: {
      async purgeTenant() {
        return 0
      },
    } as never,
    vectorStore: {} as never,
    idempotency: {
      async bumpEpoch() {
        if (epochFails) throw new Error('epoch store down')
      },
    } as never,
    runScoped: (_t, fn) => fn(),
    embeddingsEnabled: false,
    getRedis: async () => ({
      async set() {
        return 'OK'
      },
      async del() {},
    }),
  })
}

/** Pull the first fragment (or completion) out of a provider stream. */
async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const fragment of iterable) {
    void fragment
  }
}

const okResponse = () => new Response(null, { status: 200 })

/** A minimal read tool for the tool-gate recipes. */
const readToolDef = () => ({
  name: 'read',
  description: 'a read tool',
  inputSchema: {},
  handler: async () => ({ ok: true }),
})

/** A number-argument schema for the input-validation recipe. */
const numberSchema = {
  name: 'read',
  inputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
}

/** Build a one-round tool loop that "always" calls a tool, so maxRounds:1 trips the budget guard. */
const budgetLoop = (alwaysCalls: boolean) =>
  buildToolLoopProducer({
    tenantId: 'tenant-1',
    provider: new MockAIProvider({
      rounds: alwaysCalls
        ? [
            [
              {
                data: '',
                tokens: 0,
                event: 'tool_call',
                toolCall: { id: 'c', name: 'read', arguments: '{}' },
              },
            ],
          ]
        : [[{ data: 'answer', tokens: 0 }]],
    }),
    baseRequest: { messages: [{ role: 'user', content: 'hi' }] },
    tools: [{ name: 'read', description: 'd', inputSchema: {} }],
    executor: { execute: async () => ({ role: 'tool', content: 'x', toolCallId: 'c' }) },
    perRoundMaxTokens: 100,
    maxRounds: 1,
  })(new AbortController().signal)

const TRIP_MATRIX: Record<AiGuardId, TripRecipe> = {
  'guard.ai_provider_allowlist': {
    trip: () =>
      resolveTenantProviderSelection(tenant, {
        allowedProviders: ['claude'],
        defaultProvider: 'deepseek',
      } as AiConfig),
    expectThrow: /not allow-listed/,
    happy: () =>
      resolveTenantProviderSelection(tenant, { allowedProviders: ['claude'] } as AiConfig),
  },
  'guard.ai_model_allowlist': {
    trip: () =>
      drain(
        new ClaudeProvider(
          { apiKey: 'k', allowedModels: ['claude-opus-4-8'] },
          {
            fetch: async () => {
              throw new Error('the model gate must reject before any fetch')
            },
          }
        ).stream(
          { messages: [{ role: 'user', content: 'hi' }], model: 'evil-model' },
          new AbortController().signal
        )
      ),
    expectThrow: /not allow-listed/,
    happy: () =>
      drain(
        new ClaudeProvider(
          { apiKey: 'k', allowedModels: ['claude-opus-4-8'] },
          { fetch: async () => okResponse() }
        ).stream(
          { messages: [{ role: 'user', content: 'hi' }], model: 'claude-opus-4-8' },
          new AbortController().signal
        )
      ),
  },
  'guard.ai_route_mount': {
    trip: () =>
      assertAiMountAllowed({ middleware: [] }, { allowedProviders: ['claude'] } as AiConfig),
    expectThrow: /Refusing to mount AI routes/,
    happy: () =>
      assertAiMountAllowed({ middleware: 'auth' }, {
        allowedProviders: ['claude'],
        authorizeAIAccess: () => true,
      } as AiConfig),
  },
  'guard.ai_access': {
    trip: () =>
      authorizeAiAccess({} as never, tenant, {
        allowedProviders: ['claude'],
        authorizeAIAccess: () => false,
      } as AiConfig),
    expectThrow: /Not authorized for this tenant/,
    happy: () =>
      authorizeAiAccess({} as never, tenant, {
        allowedProviders: ['claude'],
        authorizeAIAccess: () => true,
      } as AiConfig),
  },
  'guard.ai_idempotency_key': {
    trip: () => validateIdempotencyKeyHeader('', 'tenant-1'),
    expectThrow: /malformed Idempotency-Key/,
    happy: () => validateIdempotencyKeyHeader('retry-abc-123', 'tenant-1'),
  },
  'guard.ai_streaming_capability': {
    trip: () =>
      new AIProviderRegistry().register(
        new MockAIProvider({ name: 'claude', contractVersion: 2, streaming: false })
      ),
    expectThrow: /does not declare capabilities\.streaming/,
    happy: () =>
      new AIProviderRegistry().register(new MockAIProvider({ name: 'claude', contractVersion: 2 })),
  },
  'guard.ai_config_invalid': {
    trip: () => assertAiConfig({ allowedProviders: [] } as unknown as AiConfig),
    expectThrow: /allowedProviders must be a non-empty array/,
    happy: () => assertAiConfig({ allowedProviders: ['claude'], claude: { apiKey: 'k' } }),
  },
  'guard.ai_rate_limited': {
    trip: () =>
      new AiRateLimiter({
        consume: async () => ({ count: 99 }),
        policy: { limit: 1, windowSeconds: 60 },
      }).check({ op: 'chat', tenantId: 'tenant-1', fingerprint: 'fp' }),
    expectThrow: /rate limit was exceeded/,
    happy: () =>
      new AiRateLimiter({
        consume: async () => ({ count: 1 }),
        policy: { limit: 1, windowSeconds: 60 },
      }).check({ op: 'chat', tenantId: 'tenant-1', fingerprint: 'fp' }),
  },
  'guard.ai_rowscope_refused': {
    trip: () => new VectorStoreService(fakeVectorEnv({ kind: 'rowscope' }).deps).count(tenant),
    expectThrow: /rowscope isolation/,
    happy: () =>
      new VectorStoreService(fakeVectorEnv({ kind: 'schema', count: 0 }).deps).count(tenant),
  },
  'guard.ai_scope_mismatch': {
    trip: () =>
      new VectorStoreService(fakeVectorEnv({ activeScope: 'someone-else' }).deps).count(tenant),
    expectThrow: /does not match the active tenancy scope/,
    happy: () =>
      new VectorStoreService(fakeVectorEnv({ activeScope: 'tenant-1' }).deps).count(tenant),
  },
  'guard.ai_dimension_mismatch': {
    trip: () =>
      new VectorStoreService(fakeVectorEnv({ dimension: 8 }).deps).insert(tenant, 'src', [
        embChunk([1, 2, 3]),
      ]),
    expectThrow: /index dimension is 8/,
    happy: () =>
      new VectorStoreService(
        fakeVectorEnv({ dimension: 3, existing: [storedRow], insertedHashes: ['h'] }).deps
      ).insert(tenant, 'src', [embChunk([1, 2, 3])]),
  },
  'guard.ai_embedding_quota_exhausted': {
    trip: () =>
      new VectorStoreService(fakeVectorEnv({ dimension: 3, count: 5 }).deps).insert(
        tenant,
        'src',
        [embChunk([1, 2, 3])],
        { maxCount: 5 }
      ),
    expectThrow: /plan limit embeddingCount/,
    happy: () =>
      new VectorStoreService(
        fakeVectorEnv({ dimension: 3, count: 2, existing: [storedRow], insertedHashes: ['h'] }).deps
      ).insert(tenant, 'src', [embChunk([1, 2, 3])], { maxCount: 5 }),
  },
  'guard.ai_ingestion_denied': {
    trip: () =>
      authorizeIngestion({} as never, tenant, { authorizeIngestion: () => false } as never),
    expectThrow: /Refusing the ingest/,
    happy: () =>
      authorizeIngestion({} as never, tenant, { authorizeIngestion: () => true } as never),
  },
  'guard.ai_retrieval_denied': {
    trip: () =>
      resolveRetrievalScope({} as never, tenant, {
        retrieval: {
          retrievalFilter: () => {
            throw new Error('acl backend down')
          },
        },
      } as never),
    expectThrow: /Refusing the retrieval/,
    happy: () =>
      resolveRetrievalScope({} as never, tenant, {
        retrieval: { retrievalFilter: () => ({ kind: 'all' }) },
      } as never),
  },
  'guard.ai_audit_write_failed': {
    trip: () =>
      new AiAuditWriter(fakeAuditEnv({ failInsert: 'always' }).deps).append(sampleAuditRow()),
    expectThrow: /audit row could not be written/,
    happy: () => new AiAuditWriter(fakeAuditEnv().deps).append(sampleAuditRow()),
  },
  'guard.ai_memory_session_invalid': {
    // mintSession/resolveSession are pure crypto (no Redis), so the fake store is never touched.
    trip: () => {
      const mem = memoryForMatrix()
      const { token } = mem.mintSession('tenant-1', 'user-a')
      // Same token, DIFFERENT principal: the session MAC cannot verify (G6).
      return mem.resolveSession(token, 'tenant-1', 'user-b')
    },
    expectThrow: /session token does not verify/,
    happy: () => {
      const mem = memoryForMatrix()
      const { token } = mem.mintSession('tenant-1', 'user-a')
      return mem.resolveSession(token, 'tenant-1', 'user-a')
    },
  },
  'guard.ai_residency_denied': {
    trip: () =>
      enforceChatResidency(tenant, 'deepseek', {
        allowedProviders: ['claude', 'deepseek'],
        residency: () => ({ allowedProviders: ['claude'] }),
      } as AiConfig),
    expectThrow: /does not permit this egress/,
    happy: () =>
      enforceChatResidency(tenant, 'claude', {
        allowedProviders: ['claude'],
        residency: () => ({ allowedProviders: ['claude'] }),
      } as AiConfig),
  },
  'guard.ai_auto_purge_failed': {
    // A SIGNAL guard: the lifecycle auto-purge is non-throwing, so a failed gate
    // emits the guard WITHOUT throwing (expectThrow: null).
    trip: () => complianceForMatrix(true).autoPurge(tenant, 'tenant_deleted'),
    expectThrow: null,
    happy: () => complianceForMatrix(false).autoPurge(tenant, 'tenant_deleted'),
  },
  'guard.ai_tool_unknown': {
    trip: () => resolveKnownTool([], 'ghost-tool', 'tenant-1'),
    expectThrow: /unknown tool/,
    happy: () => resolveKnownTool([readToolDef()], 'read', 'tenant-1'),
  },
  'guard.ai_tool_denied': {
    trip: () =>
      authorizeToolScope({} as never, tenant, 'read', {
        authorizeTool: () => {
          throw new Error('acl backend down')
        },
      }),
    expectThrow: /not authorized/,
    happy: () =>
      authorizeToolScope({} as never, tenant, 'read', { authorizeTool: () => ({ kind: 'allow' }) }),
  },
  'guard.ai_tool_input_invalid': {
    trip: () => validateToolInput('{"n":"not-a-number"}', numberSchema, { tenantId: 'tenant-1' }),
    expectThrow: /Refusing the tool call/,
    happy: () => validateToolInput('{"n":5}', numberSchema, { tenantId: 'tenant-1' }),
  },
  'guard.ai_tool_scope_mismatch': {
    trip: () => assertActiveToolScope('someone-else', 'tenant-1'),
    expectThrow: /does not match the active tenancy scope/,
    happy: () => assertActiveToolScope('tenant-1', 'tenant-1'),
  },
  'guard.ai_tool_budget_exhausted': {
    trip: () => drain(budgetLoop(true)),
    expectThrow: /maximum number of rounds/,
    happy: () => drain(budgetLoop(false)),
  },
  'guard.ai_tool_action_disabled': {
    trip: () =>
      assertActionAllowed(
        {
          name: 'delete_all',
          description: 'd',
          inputSchema: {},
          mode: 'action',
          handler: async () => ({}),
        },
        'tenant-1'
      ),
    expectThrow: /action \(mutating\) tools are disabled/,
    happy: () =>
      assertActionAllowed(
        { name: 'read', description: 'd', inputSchema: {}, handler: async () => ({}) },
        'tenant-1'
      ),
  },
}

function registryIds(): AiGuardId[] {
  return AI_GUARD_REGISTRY.map((e) => e.id)
}

test.group('AI guard emission matrix — completeness', () => {
  test('every registry id has a matrix entry', ({ assert }) => {
    const missing = registryIds().filter((id) => !(id in TRIP_MATRIX))
    assert.deepEqual(missing, [], `guards with no behavioral test: ${missing.join(', ')}`)
  })

  test('every matrix key is a real registry id', ({ assert }) => {
    const ids = new Set<string>(registryIds())
    const stray = Object.keys(TRIP_MATRIX).filter((id) => !ids.has(id))
    assert.deepEqual(stray, [], `matrix keys not in the registry: ${stray.join(', ')}`)
  })
})

test.group('AI guard emission matrix — trip + happy', (group) => {
  let captured: IsthmusGuardTrippedPayload[] = []

  group.each.setup(() => {
    captured = []
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
    __setAiGuardDispatcherForTests(async (payload) => {
      captured.push(payload)
    })
  })

  group.each.teardown(() => {
    __setAiGuardDispatcherForTests(undefined)
    setAiGuardMetricSink(undefined)
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
  })

  for (const id of Object.keys(TRIP_MATRIX) as AiGuardId[]) {
    const recipe = TRIP_MATRIX[id]
    const entry = AI_GUARD_REGISTRY.find((e) => e.id === id)!

    test(`${id}: tripping emits exactly one matching event, unchanged exception`, async ({
      assert,
    }) => {
      let threw: unknown
      try {
        await recipe.trip()
      } catch (err) {
        threw = err
      }
      await settle()

      if (recipe.expectThrow === null) {
        assert.isUndefined(threw, `${id}: a signal guard must emit WITHOUT throwing`)
      } else {
        assert.isDefined(threw, `${id}: trip recipe did not throw`)
        assert.match(
          (threw as Error).message,
          recipe.expectThrow,
          `${id}: exception message changed`
        )
      }

      assert.lengthOf(captured, 1, `${id}: expected exactly one dispatch`)
      assert.equal(captured[0].id, id)
      assert.equal(captured[0].severity, entry.severity)
      assert.equal(captured[0].event, entry.event)
      assert.equal(captured[0].pillar, 'guard')

      // Metadata values stay short (the guards truncate to <= 64 chars).
      for (const value of Object.values(captured[0].metadata)) {
        if (typeof value === 'string') assert.isAtMost(value.length, 64, `${id}: metadata too long`)
      }

      const snapshot = snapshotAiGuardCounters()
      const guarded = snapshot.guarded
        .filter((g) => g.severity === entry.severity)
        .reduce((sum, g) => sum + g.value, 0)
      assert.equal(guarded, 1, `${id}: guarded delta must be exactly 1`)
      assert.equal(
        snapshot.rejected.find((r) => r.id === id)?.value ?? 0,
        1,
        `${id}: rejected delta must be exactly 1`
      )
    })

    test(`${id}: a happy input emits nothing`, async ({ assert }) => {
      await recipe.happy()
      await settle()

      assert.lengthOf(captured, 0, `${id}: happy input must not emit`)
      const snapshot = snapshotAiGuardCounters()
      assert.lengthOf(snapshot.guarded, 0, `${id}: happy input must not bump guarded`)
      assert.lengthOf(snapshot.rejected, 0, `${id}: happy input must not bump rejected`)
    })
  }
})

test.group('AI guard audit — budgets, drops and the metric bridge', (group) => {
  let captured: IsthmusGuardTrippedPayload[] = []

  group.each.setup(() => {
    captured = []
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
    __setAiGuardDispatcherForTests(async (payload) => {
      captured.push(payload)
    })
  })

  group.each.teardown(() => {
    __setAiGuardDispatcherForTests(undefined)
    setAiGuardMetricSink(undefined)
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
  })

  test('counters keep exact totals when the per-severity budget drops dispatches', async ({
    assert,
  }) => {
    // guard.ai_config_invalid is severity warn; one over budget in one window.
    const budget = ISTHMUS_BUDGETS.warn
    for (let i = 0; i <= budget; i++) {
      try {
        assertAiConfig({ allowedProviders: [] } as unknown as AiConfig)
      } catch {
        // The guard's own throw; the emission is what this test observes.
      }
    }
    await settle()

    assert.lengthOf(captured, budget, 'dispatches must stop at the window budget')
    const snapshot = snapshotAiGuardCounters()
    assert.equal(
      snapshot.rejected.find((r) => r.id === 'guard.ai_config_invalid')?.value,
      budget + 1,
      'rejected counts every trip, dropped or not'
    )
    assert.deepEqual(
      snapshot.dropped,
      [{ severity: 'warn', reason: 'rate_limited', value: 1 }],
      'the over-budget dispatch is a counted drop'
    )
  })

  test('an async-rejecting dispatcher lands in dropped{no_emitter}', async ({ assert }) => {
    __setAiGuardDispatcherForTests(async () => {
      throw new Error('listener exploded')
    })
    emitAiGuardEvent('guard.ai_provider_allowlist', { tenantId: 't1' })
    await settle()

    const snapshot = snapshotAiGuardCounters()
    assert.deepEqual(snapshot.dropped, [{ severity: 'high', reason: 'no_emitter', value: 1 }])
  })

  test('a SYNCHRONOUSLY-throwing dispatcher is still a counted drop, not an escape', async ({
    assert,
  }) => {
    // The kernel hardened exactly this path: a bare dispatch(payload).catch
    // would throw before .catch attaches and the drop would vanish uncounted.
    __setAiGuardDispatcherForTests(((): Promise<void> => {
      throw new Error('sync boom')
    }) as unknown as Parameters<typeof __setAiGuardDispatcherForTests>[0])

    assert.doesNotThrow(() => emitAiGuardEvent('guard.ai_provider_allowlist', { tenantId: 't1' }))
    await settle()

    const snapshot = snapshotAiGuardCounters()
    assert.deepEqual(snapshot.dropped, [{ severity: 'high', reason: 'no_emitter', value: 1 }])
  })

  test('the default dispatcher degrades to a counted drop in a bare runner', async ({ assert }) => {
    // No booted app here: the lazy event dispatch cannot reach an emitter, and
    // that must surface as dropped{no_emitter}, never as a throw. The first
    // default dispatch loads the events module from disk, so poll (bounded)
    // instead of assuming a fixed number of ticks.
    __setAiGuardDispatcherForTests(undefined)
    assert.doesNotThrow(() => emitAiGuardEvent('guard.ai_provider_allowlist', { tenantId: 't1' }))
    for (let i = 0; i < 200 && snapshotAiGuardCounters().dropped.length === 0; i++) {
      await settle()
    }

    const snapshot = snapshotAiGuardCounters()
    assert.equal(
      snapshot.rejected.find((r) => r.id === 'guard.ai_provider_allowlist')?.value,
      1,
      'the counter is exact regardless of dispatch fate'
    )
    assert.deepEqual(snapshot.dropped, [{ severity: 'high', reason: 'no_emitter', value: 1 }])
  })

  test('a tenantful trip bridges exactly one ai_guard_rejections metric', async ({ assert }) => {
    const metrics: Array<{ tenantId: string; name: string; value: number }> = []
    setAiGuardMetricSink((tenantId, name, value) => {
      metrics.push({ tenantId, name, value })
    })

    try {
      resolveTenantProviderSelection(tenant, {
        allowedProviders: ['claude'],
        defaultProvider: 'deepseek',
      } as AiConfig)
    } catch {
      // The guard's own throw.
    }
    await settle()

    assert.deepEqual(metrics, [
      { tenantId: 'tenant-1', name: AI_GUARD_REJECTIONS_METRIC, value: 1 },
    ])
  })

  test('a tenant-less trip never reaches the metric sink', async ({ assert }) => {
    const metrics: unknown[] = []
    setAiGuardMetricSink((...call) => {
      metrics.push(call)
    })

    try {
      assertAiConfig({ allowedProviders: [] } as unknown as AiConfig)
    } catch {
      // The guard's own throw.
    }
    await settle()

    assert.lengthOf(metrics, 0, 'boot and mount guards are tenant-less by design')
  })

  test('a synchronously-throwing metric sink cannot break the reject path or the event', async ({
    assert,
  }) => {
    setAiGuardMetricSink(() => {
      throw new Error('metrics backend down')
    })

    assert.throws(
      () =>
        resolveTenantProviderSelection(tenant, {
          allowedProviders: ['claude'],
          defaultProvider: 'deepseek',
        } as AiConfig),
      /not allow-listed/
    )
    await settle()

    assert.lengthOf(captured, 1, 'the event still dispatches when the metric sink fails')
  })
})
