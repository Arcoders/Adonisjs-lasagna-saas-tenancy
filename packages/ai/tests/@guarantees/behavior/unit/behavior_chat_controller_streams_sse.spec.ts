import { test } from '@japa/runner'
import AiChatController from '../../../../src/gateway/ai_chat_controller.js'
import AIProviderRegistry from '../../../../src/services/ai_provider_registry.js'
import TenantLivenessWatcher from '../../../../src/services/tenant_liveness_watcher.js'
import AiRateLimiter from '../../../../src/services/ai_rate_limiter.js'
import AiIdempotencyService, {
  deriveAiIdempotencyMacKey,
  type AiIdempotencyStore,
} from '../../../../src/gateway/idempotency.js'
import MockAIProvider from '../../../../src/testing/mock_ai_provider.js'
import { FakeQuota, makeService, fakeTenant } from '../../../helpers/stream_doubles.js'
import { fakeHttpContext } from '../../../helpers/fake_http_context.js'
import type { AiConfig } from '../../../../src/define_config.js'

/**
 * The happy chat path through the REAL StreamExtensionService (quota/breaker
 * doubles, MockAIProvider producer): SSE headers flushed once, monotonic token
 * frames, a terminal id-less `done` frame, and the idempotent second call
 * replaying the exact same frames with zero provider calls and zero cost.
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

function buildDeps(
  overrides: { quota?: FakeQuota; store?: AiIdempotencyStore; rateLimiter?: AiRateLimiter } = {}
) {
  const quota = overrides.quota ?? new FakeQuota()
  const { svc } = makeService(quota)
  const provider = new MockAIProvider({
    name: 'claude',
    contractVersion: 2,
    fragments: [
      { data: 'hola', tokens: 2 },
      { data: 'mundo', tokens: 3 },
    ],
  })
  const registry = new AIProviderRegistry()
  registry.register(provider, { activate: true })
  const config = { allowedProviders: ['claude'], authorizeAIAccess: () => true } as AiConfig
  const idempotency = new AiIdempotencyService({
    store: overrides.store ?? mapStore().store,
    macKey: deriveAiIdempotencyMacKey('test-app-key'),
  })
  const liveness = new TenantLivenessWatcher()
  const controller = new AiChatController({
    stream: svc,
    registry,
    idempotency,
    liveness,
    rateLimiter: overrides.rateLimiter,
    config,
  })
  return { controller, provider, quota, liveness, config }
}

const chatBody = { messages: [{ role: 'user', content: 'hola' }] }

test.group('chat controller SSE happy path', () => {
  test('streams token frames and a terminal done frame over SSE', async ({ assert }) => {
    const { controller, quota, liveness } = buildDeps()
    const { ctx, res } = fakeHttpContext({ tenant: fakeTenant, body: chatBody })

    await controller.chat(ctx)

    assert.isTrue(res.flushed, 'SSE headers must flush')
    assert.equal(res.headers['content-type'], 'text/event-stream')
    assert.equal(res.headers['cache-control'], 'no-cache, no-transform')
    assert.include(res.output, 'id: 1\nevent: token\ndata: hola\n\n')
    assert.include(res.output, 'id: 2\nevent: token\ndata: mundo\n\n')
    assert.isTrue(res.output.endsWith('event: done\ndata: {"outcome":"completed"}\n\n'))
    assert.isTrue(res.ended, 'the controller owns stream termination')
    assert.notInclude(res.output, 'id: 3', 'the done frame is id-less by design')
    assert.equal(quota.settles.at(-1), 5, 'the finally settled the full cumulative cost')
    assert.equal(quota.releases, 1)
    assert.equal(liveness.watchedTenantCount(), 0, 'the liveness handle was disposed')
  })

  test('an idempotent retry replays the same frames with zero provider calls', async ({
    assert,
  }) => {
    const shared = mapStore()
    const { controller, provider, quota } = buildDeps({ store: shared.store })
    const requestOptions = {
      tenant: fakeTenant,
      body: chatBody,
      headers: { 'idempotency-key': 'retry-42' },
      auth: { user: { id: 'u1' } },
    }

    const first = fakeHttpContext(requestOptions)
    await controller.chat(first.ctx)
    assert.lengthOf(provider.calls, 1)
    assert.isUndefined(first.res.headers['x-ai-idempotent-replay'])

    const second = fakeHttpContext(requestOptions)
    await controller.chat(second.ctx)

    assert.lengthOf(provider.calls, 1, 'the replay must not touch the provider')
    assert.equal(second.res.headers['x-ai-idempotent-replay'], '1')
    assert.equal(
      second.res.output,
      first.res.output,
      'the replay is byte-identical, original event ids included'
    )
    assert.lengthOf(
      quota.settles.filter((v) => v === 5),
      2,
      'only the FIRST call settled (per-write + finally); the replay reserved nothing'
    )
  })

  test('a resuming replay honours Last-Event-ID: already-seen frames are skipped', async ({
    assert,
  }) => {
    const shared = mapStore()
    const { controller, provider } = buildDeps({ store: shared.store })
    const base = {
      tenant: fakeTenant,
      body: chatBody,
      auth: { user: { id: 'u1' } },
    }

    await controller.chat(
      fakeHttpContext({ ...base, headers: { 'idempotency-key': 'retry-42' } }).ctx
    )

    // An SSE client that received frame 1 reconnects: same key, a resume cursor.
    const resumed = fakeHttpContext({
      ...base,
      headers: { 'idempotency-key': 'retry-42', 'last-event-id': '1' },
    })
    await controller.chat(resumed.ctx)

    assert.lengthOf(provider.calls, 1, 'still a replay, not a fresh stream')
    assert.equal(resumed.res.headers['x-ai-idempotent-replay'], '1')
    assert.notInclude(resumed.res.output, 'data: hola', 'frame 1 was already delivered')
    assert.include(resumed.res.output, 'id: 2\nevent: token\ndata: mundo\n\n')
    assert.isTrue(resumed.res.output.endsWith('event: done\ndata: {"outcome":"completed"}\n\n'))

    // A cursor at the end replays only the done frame; a garbage cursor replays all.
    const caughtUp = fakeHttpContext({
      ...base,
      headers: { 'idempotency-key': 'retry-42', 'last-event-id': '2' },
    })
    await controller.chat(caughtUp.ctx)
    assert.notInclude(caughtUp.res.output, 'event: token')

    const garbage = fakeHttpContext({
      ...base,
      headers: { 'idempotency-key': 'retry-42', 'last-event-id': 'not-a-number' },
    })
    await controller.chat(garbage.ctx)
    assert.include(garbage.res.output, 'data: hola')
    assert.include(garbage.res.output, 'data: mundo')
  })

  test('a different Idempotency-Key streams fresh (a key is a scope, not a switch)', async ({
    assert,
  }) => {
    const shared = mapStore()
    const { controller, provider } = buildDeps({ store: shared.store })
    const base = {
      tenant: fakeTenant,
      body: chatBody,
      auth: { user: { id: 'u1' } },
    }

    await controller.chat(
      fakeHttpContext({ ...base, headers: { 'idempotency-key': 'retry-a' } }).ctx
    )
    await controller.chat(
      fakeHttpContext({ ...base, headers: { 'idempotency-key': 'retry-b' } }).ctx
    )

    assert.lengthOf(provider.calls, 2)
  })

  test('a replay does not consume the per-key rate limit', async ({ assert }) => {
    const shared = mapStore()
    let consumeCalls = 0
    const rateLimiter = new AiRateLimiter({
      consume: async () => {
        consumeCalls++
        return { count: 1 }
      },
      policy: { limit: 5, windowSeconds: 60 },
    })
    const { controller, provider } = buildDeps({ store: shared.store, rateLimiter })
    const requestOptions = {
      tenant: fakeTenant,
      body: chatBody,
      headers: { 'idempotency-key': 'retry-rl' },
      auth: { user: { id: 'u1' } },
    }

    await controller.chat(fakeHttpContext(requestOptions).ctx) // fresh: consumes once
    await controller.chat(fakeHttpContext(requestOptions).ctx) // replay: must not consume

    assert.lengthOf(provider.calls, 1, 'the replay does not touch the provider')
    assert.equal(
      consumeCalls,
      1,
      'only the fresh call consumed the rate limit; the replay skipped it'
    )
  })

  test('the request maxTokens is clamped by the config ceiling', async ({ assert }) => {
    class RecordingQuota extends FakeQuota {
      readonly reserves: number[] = []
      override async reserve(_tenant?: unknown, _quota?: unknown, worstCase?: number) {
        if (typeof worstCase === 'number') this.reserves.push(worstCase)
        return super.reserve()
      }
    }
    const quota = new RecordingQuota()
    const { controller } = buildDeps({ quota })
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: { ...chatBody, maxTokens: 999_999 },
    })

    await controller.chat(ctx)

    assert.deepEqual(quota.reserves, [1024], 'DEFAULT_AI_MAX_TOKENS bounds a greedy request')
  })
})
