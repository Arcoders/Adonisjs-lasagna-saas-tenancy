import { test } from '@japa/runner'
import AiChatController from '../../../../src/gateway/ai_chat_controller.js'
import AIProviderRegistry from '../../../../src/services/ai_provider_registry.js'
import TenantLivenessWatcher from '../../../../src/services/tenant_liveness_watcher.js'
import AiIdempotencyService, {
  deriveAiIdempotencyMacKey,
  type AiIdempotencyStore,
} from '../../../../src/gateway/idempotency.js'
import ConversationMemoryService from '../../../../src/services/conversation_memory_service.js'
import MockAIProvider from '../../../../src/testing/mock_ai_provider.js'
import { FakeQuota, makeService, fakeTenant } from '../../../helpers/stream_doubles.js'
import { fakeHttpContext } from '../../../helpers/fake_http_context.js'
import { FakeRedisLists } from '../../../helpers/fake_redis_lists.js'
import type { AiConfig, RedactOutput } from '../../../../src/define_config.js'
import type { StreamFragment } from '../../../../src/types/ai_provider_contract.js'

/**
 * The `redactOutput` coherence proofs (the enterprise
 * "no-gap" core). Because redaction sits at the single fragment choke point
 * upstream of the recording tee, the redacted bytes are what the client, the
 * idempotency cache, AND conversation memory all see. Driven through the REAL
 * StreamExtensionService + recording target + idempotency + memory services
 * (only the Redis/cache backends are in-memory doubles), so the coherence is the
 * production path, not a mock of it.
 */

function mapStore(): { store: AiIdempotencyStore; data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    store: {
      async get(tenantId, key) {
        return data.get(`${tenantId}|${key}`)
      },
      async set(tenantId, key, value) {
        data.set(`${tenantId}|${key}`, value)
      },
    },
  }
}

interface BuildOptions {
  fragments: StreamFragment[]
  redactOutput?: RedactOutput
  withMemory?: boolean
  store?: AiIdempotencyStore
  redis?: FakeRedisLists
}

function buildDeps(opts: BuildOptions) {
  const quota = new FakeQuota()
  const { svc } = makeService(quota)
  const provider = new MockAIProvider({
    name: 'claude',
    contractVersion: 2,
    fragments: opts.fragments,
  })
  const registry = new AIProviderRegistry()
  registry.register(provider, { activate: true })
  const config = {
    allowedProviders: ['claude'],
    authorizeAIAccess: () => true,
    redactOutput: opts.redactOutput,
    ...(opts.withMemory ? { memory: { maxTurns: 5, ttlMs: 60_000 } } : {}),
  } as AiConfig
  const idempotency = new AiIdempotencyService({
    store: opts.store ?? mapStore().store,
    macKey: deriveAiIdempotencyMacKey('test-app-key'),
  })
  const memory = opts.withMemory
    ? new ConversationMemoryService({
        getRedis: async () => opts.redis ?? new FakeRedisLists(),
        macKey: Buffer.alloc(32, 4),
        encryptMemory: (plain) => `e:${plain}`,
        decryptMemory: (cipher) => {
          if (!cipher.startsWith('e:')) throw new Error('not ciphertext')
          return cipher.slice(2)
        },
        config: { maxTurns: 5, ttlMs: 60_000 },
      })
    : undefined
  const metrics: Array<{ tenantId: string; name: string; value: number }> = []
  const controller = new AiChatController({
    stream: svc,
    registry,
    idempotency,
    liveness: new TenantLivenessWatcher(),
    config,
    memory,
    emitMetric: (tenantId, name, value) => metrics.push({ tenantId, name, value }),
  })
  return { controller, provider, quota, metrics }
}

const auth = { user: { id: 'u1' } }

test.group('redactOutput coherence — client + idempotency replay', () => {
  test('the client stream is redacted and the metric counts the change', async ({ assert }) => {
    let calls = 0
    const redact: RedactOutput = (_c, _t, chunk) => {
      calls++
      return chunk.replace('SECRET', '[redacted]')
    }
    const { controller, metrics } = buildDeps({
      fragments: [
        { data: 'my SECRET', tokens: 2 },
        { data: 'ok', tokens: 3 },
      ],
      redactOutput: redact,
    })
    const { ctx, res } = fakeHttpContext({
      tenant: fakeTenant,
      body: { messages: [{ role: 'user', content: 'q' }] },
    })

    await controller.chat(ctx)

    assert.include(res.output, 'data: my [redacted]')
    assert.notInclude(res.output, 'SECRET', 'the un-redacted token never reaches the socket')
    assert.equal(calls, 2, 'the redactor sees every fragment')
    assert.deepEqual(
      metrics.filter((m) => m.name === 'ai_output_redacted'),
      [{ tenantId: fakeTenant.id, name: 'ai_output_redacted', value: 1 }],
      'only the changed fragment is counted (the unchanged one is not)'
    )
  })

  test('an idempotent replay serves the redacted bytes and does NOT re-run the redactor', async ({
    assert,
  }) => {
    const shared = mapStore()
    let calls = 0
    const redact: RedactOutput = (_c, _t, chunk) => {
      calls++
      return chunk.replace('SECRET', '[redacted]')
    }
    const { controller, provider } = buildDeps({
      fragments: [{ data: 'a SECRET b', tokens: 4 }],
      redactOutput: redact,
      store: shared.store,
    })
    const options = {
      tenant: fakeTenant,
      body: { messages: [{ role: 'user', content: 'q' }] },
      headers: { 'idempotency-key': 'redact-1' },
      auth,
    }

    const first = fakeHttpContext(options)
    await controller.chat(first.ctx)
    assert.include(first.res.output, 'a [redacted] b')
    assert.equal(calls, 1)

    const second = fakeHttpContext(options)
    await controller.chat(second.ctx)

    assert.lengthOf(provider.calls, 1, 'the replay never touches the provider')
    assert.equal(second.res.headers['x-ai-idempotent-replay'], '1')
    assert.equal(second.res.output, first.res.output, 'the replay is the same redacted bytes')
    assert.equal(
      calls,
      1,
      'the replay reuses cached redacted frames, never re-running the redactor'
    )
  })
})

test.group('redactOutput coherence — conversation memory', () => {
  test('memory persists the REDACTED assistant turn (the model never re-sees the raw output)', async ({
    assert,
  }) => {
    const redact: RedactOutput = (_c, _t, chunk) => chunk.replace('SECRET', '[redacted]')
    const { controller, provider } = buildDeps({
      fragments: [{ data: 'hi SECRET', tokens: 1 }],
      redactOutput: redact,
      withMemory: true,
      redis: new FakeRedisLists(),
    })

    const t1 = fakeHttpContext({
      tenant: fakeTenant,
      body: { messages: [{ role: 'user', content: 'first' }] },
      auth,
    })
    await controller.chat(t1.ctx)
    const token = t1.res.headers['x-ai-session']
    assert.isString(token)
    assert.include(t1.res.output, 'hi [redacted]')

    const t2 = fakeHttpContext({
      tenant: fakeTenant,
      body: { messages: [{ role: 'user', content: 'second' }], sessionId: token },
      auth,
    })
    await controller.chat(t2.ctx)

    assert.deepEqual(
      provider.calls[1].request.messages,
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'hi [redacted]' },
        { role: 'user', content: 'second' },
      ],
      'the replayed assistant turn is the redacted text, not the raw model output'
    )
  })
})

test.group('redactOutput coherence — fail-closed + cost', () => {
  test('a throwing redactor mid-stream aborts cleanly; prior tokens still settle', async ({
    assert,
  }) => {
    const redact: RedactOutput = (_c, _t, chunk) => {
      if (chunk.includes('mundo')) throw new Error('DLP backend down')
      return chunk
    }
    const { controller, quota, metrics } = buildDeps({
      fragments: [
        { data: 'hola', tokens: 2 },
        { data: 'mundo', tokens: 3 },
      ],
      redactOutput: redact,
    })
    const { ctx, res } = fakeHttpContext({
      tenant: fakeTenant,
      body: { messages: [{ role: 'user', content: 'q' }] },
    })

    await controller.chat(ctx)

    assert.include(res.output, 'data: hola', 'the fragment before the failure is delivered')
    assert.notInclude(res.output, 'mundo', 'the failing fragment is never emitted (fail-closed)')
    assert.include(res.output, '"outcome":"aborted"')
    assert.include(res.output, '"reason":"fragment_rejected"')
    assert.equal(quota.settles.at(-1), 2, 'only the delivered fragment settled')
    assert.deepEqual(
      metrics.filter((m) => m.name === 'ai_output_redacted'),
      [{ tenantId: fakeTenant.id, name: 'ai_output_redacted', value: 1 }],
      'the fail-closed abort is counted'
    )
  })

  test('redaction does not change cost: tokens settle on the original fragment totals', async ({
    assert,
  }) => {
    const redact: RedactOutput = (_c, _t, chunk) => chunk.replace('SECRET', '[redacted]')
    const { controller, quota } = buildDeps({
      fragments: [
        { data: 'a SECRET', tokens: 2 },
        { data: 'b SECRET', tokens: 3 },
      ],
      redactOutput: redact,
    })
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: { messages: [{ role: 'user', content: 'q' }] },
    })

    await controller.chat(ctx)

    assert.equal(
      quota.settles.at(-1),
      5,
      'settlement is on provider tokens, unaffected by redaction'
    )
  })
})
