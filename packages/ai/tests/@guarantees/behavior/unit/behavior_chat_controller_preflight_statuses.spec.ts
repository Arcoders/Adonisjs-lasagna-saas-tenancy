import { test } from '@japa/runner'
import { TenantAccessForbiddenException } from '@adonisjs-lasagna/saas-tenancy/exceptions'
import AiChatController from '../../../../src/gateway/ai_chat_controller.js'
import AIProviderRegistry from '../../../../src/services/ai_provider_registry.js'
import TenantLivenessWatcher from '../../../../src/services/tenant_liveness_watcher.js'
import AiRateLimiter from '../../../../src/services/ai_rate_limiter.js'
import AiIdempotencyService, {
  deriveAiIdempotencyMacKey,
} from '../../../../src/gateway/idempotency.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import MockAIProvider from '../../../../src/testing/mock_ai_provider.js'
import type { AIProviderContract } from '../../../../src/types/ai_provider_contract.js'
import {
  FakeBreaker,
  FakeQuota,
  codedError,
  fakeTenant,
  makeService,
} from '../../../helpers/stream_doubles.js'
import { fakeHttpContext } from '../../../helpers/fake_http_context.js'
import type { AiConfig } from '../../../../src/define_config.js'

/**
 * The pre-flight status map, pinned end to end at the controller: over_budget
 * is 402, rate_limited 429, a reserve-backend outage and an open breaker 503,
 * and NONE of them flush SSE headers (the spine's commit-point contract), so
 * a real status always reaches the client. Request-shape rejections are 400s
 * that never reach reservation.
 *
 * Fatal typed refusals the provider raises before the first byte keep their own
 * pinned status rather than collapsing to a retryable 503: a model outside the
 * per-provider allow-list is 403 (provider_not_allowed), a BYOK-endpoint block
 * from the SSRF pin is 400 (byok_endpoint_blocked). Surfacing either as a 503
 * would invert retryability and let a client retry loop hammer a permanently
 * denied model or endpoint.
 */

const chatBody = { messages: [{ role: 'user', content: 'hola' }] }

function buildController(deps: {
  quota?: FakeQuota
  breaker?: FakeBreaker
  provider?: AIProviderContract
  rateLimiter?: AiRateLimiter
}) {
  const { svc } = makeService(deps.quota ?? new FakeQuota(), deps.breaker ?? new FakeBreaker())
  const registry = new AIProviderRegistry()
  registry.register(deps.provider ?? new MockAIProvider({ name: 'claude', contractVersion: 2 }), {
    activate: true,
  })
  return new AiChatController({
    stream: svc,
    registry,
    idempotency: new AiIdempotencyService({
      store: { get: async () => undefined, set: async () => {} },
      macKey: deriveAiIdempotencyMacKey('test-app-key'),
    }),
    liveness: new TenantLivenessWatcher(),
    rateLimiter: deps.rateLimiter,
    config: { allowedProviders: ['claude'], authorizeAIAccess: () => true } as AiConfig,
  })
}

test.group('chat controller pre-flight statuses', () => {
  test('over budget answers 402 with headers unsent', async ({ assert }) => {
    const quota = new FakeQuota()
    quota.reserveError = codedError('E_TENANT_QUOTA_EXCEEDED')
    const controller = buildController({ quota })
    const { ctx, res, responseFacade } = fakeHttpContext({ tenant: fakeTenant, body: chatBody })

    await controller.chat(ctx)

    assert.equal(responseFacade.sentStatus, 402)
    assert.deepEqual(responseFacade.sentBody, { error: 'over_budget' })
    assert.isFalse(res.flushed, 'a pre-flight failure must leave headers unsent')
  })

  test('a reserve-backend outage answers 503 (fail-closed cost rail)', async ({ assert }) => {
    const quota = new FakeQuota()
    quota.reserveError = codedError('E_DEPENDENCY_UNAVAILABLE')
    const controller = buildController({ quota })
    const { ctx, res, responseFacade } = fakeHttpContext({ tenant: fakeTenant, body: chatBody })

    await controller.chat(ctx)

    assert.equal(responseFacade.sentStatus, 503)
    assert.deepEqual(responseFacade.sentBody, { error: 'rate_limit_unavailable' })
    assert.isFalse(res.flushed)
  })

  test('an open breaker answers 503, not 500 (provider outage is a dependency outage)', async ({
    assert,
  }) => {
    const breaker = new FakeBreaker()
    breaker.open = true
    const controller = buildController({ breaker })
    const { ctx, res, responseFacade } = fakeHttpContext({ tenant: fakeTenant, body: chatBody })

    await controller.chat(ctx)

    assert.equal(responseFacade.sentStatus, 503)
    assert.deepEqual(responseFacade.sentBody, { error: 'provider_unavailable' })
    assert.isFalse(res.flushed)
  })

  test('a provider 429 before the first byte answers 429', async ({ assert }) => {
    const rateLimited: AIProviderContract = {
      name: 'claude',
      contractVersion: 2,
      capabilities: { streaming: true },
      async verifyConfig() {},

      async *stream(): AsyncIterable<never> {
        throw new AIException('rate_limited', 'claude returned HTTP 429')
      },
    }
    const controller = buildController({ provider: rateLimited })
    const { ctx, res, responseFacade } = fakeHttpContext({ tenant: fakeTenant, body: chatBody })

    await controller.chat(ctx)

    assert.equal(responseFacade.sentStatus, 429)
    assert.deepEqual(responseFacade.sentBody, { error: 'rate_limited' })
    assert.isFalse(res.flushed)
  })

  test('a model outside the allow-list answers 403, not a retryable 503', async ({ assert }) => {
    const notAllowed: AIProviderContract = {
      name: 'claude',
      contractVersion: 2,
      capabilities: { streaming: true },
      async verifyConfig() {},

      async *stream(): AsyncIterable<never> {
        throw new AIException(
          'provider_not_allowed',
          'Refusing to stream: model "gpt-9" is not allow-listed for claude'
        )
      },
    }
    const controller = buildController({ provider: notAllowed })
    const { ctx, res, responseFacade } = fakeHttpContext({ tenant: fakeTenant, body: chatBody })

    await controller.chat(ctx)

    assert.equal(responseFacade.sentStatus, 403)
    assert.deepEqual(responseFacade.sentBody, { error: 'provider_not_allowed' })
    assert.isFalse(res.flushed, 'a fatal refusal is a pre-flight failure: headers unsent')
  })

  test('a BYOK endpoint block answers 400, not a retryable 503', async ({ assert }) => {
    const blocked: AIProviderContract = {
      name: 'claude',
      contractVersion: 2,
      capabilities: { streaming: true },
      async verifyConfig() {},

      async *stream(): AsyncIterable<never> {
        throw new AIException('byok_endpoint_blocked', 'claude endpoint blocked')
      },
    }
    const controller = buildController({ provider: blocked })
    const { ctx, res, responseFacade } = fakeHttpContext({ tenant: fakeTenant, body: chatBody })

    await controller.chat(ctx)

    assert.equal(responseFacade.sentStatus, 400)
    assert.deepEqual(responseFacade.sentBody, { error: 'byok_endpoint_blocked' })
    assert.isFalse(res.flushed)
  })

  test('a per-key rate-limit trip answers 429 before any reservation', async ({ assert }) => {
    const quota = new FakeQuota()
    quota.reserveError = new Error('reserve must not run when rate-limited')
    const rateLimiter = new AiRateLimiter({
      consume: async () => ({ count: 99 }),
      policy: { limit: 1, windowSeconds: 60 },
    })
    const provider = new MockAIProvider({ name: 'claude', contractVersion: 2 })
    const controller = buildController({ quota, rateLimiter, provider })
    const { ctx, res, responseFacade } = fakeHttpContext({ tenant: fakeTenant, body: chatBody })

    await controller.chat(ctx)

    // The refusal is a HANDLED pre-flight 429 `{ error: 'rate_limited' }` (like the
    // reserve/retrieval refusals), never an uncaught throw, and never streams.
    assert.equal(responseFacade.sentStatus, 429)
    assert.deepEqual(responseFacade.sentBody, { error: 'rate_limited' })
    assert.isFalse(res.flushed)
    assert.lengthOf(provider.calls, 0, 'the provider is never called when rate-limited')
  })

  test('a malformed body is a 400 invalid_request that never reaches reservation', async ({
    assert,
  }) => {
    const quota = new FakeQuota()
    quota.reserveError = new Error('reserve must not be called')
    const controller = buildController({ quota })

    for (const body of [
      undefined,
      {},
      { messages: [] },
      { messages: [{ role: 'wizard', content: 'x' }] },
      { messages: [{ role: 'user', content: '' }] },
      { messages: [{ role: 'user', content: 'x' }], maxTokens: -1 },
      { messages: [{ role: 'user', content: 'x' }], model: '' },
      { messages: [{ role: 'user', content: 'x' }], sessionId: '' },
    ]) {
      const { ctx } = fakeHttpContext({ tenant: fakeTenant, body })
      let threw: unknown
      try {
        await controller.chat(ctx)
      } catch (err) {
        threw = err
      }
      assert.instanceOf(threw, AIException, `should reject: ${JSON.stringify(body)}`)
      assert.equal((threw as AIException).aiCode, 'invalid_request')
      assert.equal((threw as AIException).httpStatus, 400)
    }
  })

  test('an over-long prompt is a 400 naming the bound, not echoing content', async ({ assert }) => {
    const controller = buildController({})
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: { messages: [{ role: 'user', content: 'x'.repeat(33_000) }] },
    })
    let threw: unknown
    try {
      await controller.chat(ctx)
    } catch (err) {
      threw = err
    }
    assert.instanceOf(threw, AIException)
    assert.match((threw as Error).message, /maxPromptChars \(32000\)/)
    assert.notInclude((threw as Error).message, 'xxxx')
  })

  test('no resolvable tenant is a fail-closed 403 (mis-mounted route backstop)', async ({
    assert,
  }) => {
    const controller = buildController({})
    const { ctx } = fakeHttpContext({ tenant: null, body: chatBody })

    let threw: unknown
    try {
      await controller.chat(ctx)
    } catch (err) {
      threw = err
    }
    assert.instanceOf(threw, TenantAccessForbiddenException)
  })

  test('an access-gate denial propagates as the 403 exception', async ({ assert }) => {
    const { svc } = makeService()
    const registry = new AIProviderRegistry()
    registry.register(new MockAIProvider({ name: 'claude', contractVersion: 2 }), {
      activate: true,
    })
    const controller = new AiChatController({
      stream: svc,
      registry,
      idempotency: new AiIdempotencyService({
        store: { get: async () => undefined, set: async () => {} },
        macKey: deriveAiIdempotencyMacKey('test-app-key'),
      }),
      liveness: new TenantLivenessWatcher(),
      config: { allowedProviders: ['claude'], authorizeAIAccess: () => false } as AiConfig,
    })
    const { ctx } = fakeHttpContext({ tenant: fakeTenant, body: chatBody })

    let threw: unknown
    try {
      await controller.chat(ctx)
    } catch (err) {
      threw = err
    }
    assert.instanceOf(threw, TenantAccessForbiddenException)
  })
})
