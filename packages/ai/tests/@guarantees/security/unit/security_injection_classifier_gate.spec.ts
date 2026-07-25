import { test } from '@japa/runner'
import type { IsthmusGuardTrippedPayload } from '@adonisjs-lasagna/saas-tenancy/types'
import AiChatController from '../../../../src/gateway/ai_chat_controller.js'
import AIProviderRegistry from '../../../../src/services/ai_provider_registry.js'
import TenantLivenessWatcher from '../../../../src/services/tenant_liveness_watcher.js'
import AiIdempotencyService, {
  deriveAiIdempotencyMacKey,
} from '../../../../src/gateway/idempotency.js'
import MockAIProvider from '../../../../src/testing/mock_ai_provider.js'
import {
  enforceInjectionClassifier,
  type InjectionInput,
} from '../../../../src/gateway/injection_gate.js'
import {
  __resetAiGuardCounters,
  __resetAiGuardRateLimit,
  __setAiGuardDispatcherForTests,
} from '../../../../src/isthmus/ai_guard_audit.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import { FakeQuota, codedError, fakeTenant, makeService } from '../../../helpers/stream_doubles.js'
import { fakeHttpContext } from '../../../helpers/fake_http_context.js'
import type { AiConfig, AIInjectionConfig } from '../../../../src/define_config.js'

/**
 * Exercises the input-side `InjectionClassifier` seam through the real controller
 * pre-flight. A `block` verdict fails closed: a 400 `injection_detected` before any
 * reserve or provider call (zero spend), headers unsent, `guard.ai_injection_detected`
 * fired and the `ai_injection_detected` counter bumped. The classifier's own error
 * fails open by default (it is not the boundary), so the request proceeds and
 * `ai_injection_detector_error` fires; a host that sets `onError: 'closed'` refuses
 * instead, knowingly coupling availability. And with no `injection` block configured
 * the classifier never runs and nothing about the stream changes.
 */

const chatBody = { messages: [{ role: 'user', content: 'hola' }] }

interface BuildOpts {
  injection?: AIInjectionConfig
  quota?: FakeQuota
}

function build(opts: BuildOpts = {}) {
  const quota = opts.quota ?? new FakeQuota()
  const { svc } = makeService(quota)
  const provider = new MockAIProvider({ name: 'claude', contractVersion: 2 })
  const registry = new AIProviderRegistry()
  registry.register(provider, { activate: true })
  const metrics: { tenantId: string; name: string; value: number }[] = []
  const controller = new AiChatController({
    stream: svc,
    registry,
    idempotency: new AiIdempotencyService({
      store: { get: async () => undefined, set: async () => {} },
      macKey: deriveAiIdempotencyMacKey('test-app-key'),
    }),
    liveness: new TenantLivenessWatcher(),
    emitMetric: (tenantId, name, value) => {
      metrics.push({ tenantId, name, value })
    },
    config: {
      allowedProviders: ['claude'],
      authorizeAIAccess: () => true,
      ...(opts.injection ? { injection: opts.injection } : {}),
    } as AiConfig,
  })
  return { controller, provider, quota, metrics }
}

function metricNames(metrics: { name: string }[]): string[] {
  return metrics.map((m) => m.name)
}

test.group('injection classifier gate', (group) => {
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
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
  })

  test('a block verdict is a 400 injection_detected before any reserve (zero spend)', async ({
    assert,
  }) => {
    // reserve must NEVER run: a blocked request spends nothing.
    const quota = new FakeQuota()
    quota.reserveError = new Error('reserve must not run on a blocked request')
    const { controller, provider, metrics } = build({
      quota,
      injection: { classifier: () => ({ action: 'block' }) },
    })
    const { ctx, res, responseFacade } = fakeHttpContext({ tenant: fakeTenant, body: chatBody })

    await controller.chat(ctx)

    assert.equal(responseFacade.sentStatus, 400)
    assert.deepEqual(responseFacade.sentBody, { error: 'injection_detected' })
    assert.isFalse(res.flushed, 'a blocked request must leave headers unsent')
    assert.lengthOf(provider.calls, 0, 'the provider is never called (zero spend)')
    assert.include(metricNames(metrics), 'ai_injection_detected')
  })

  test('a block verdict fires guard.ai_injection_detected (severity high, tenantful)', async ({
    assert,
  }) => {
    const { controller } = build({ injection: { classifier: () => ({ action: 'block' }) } })
    const { ctx } = fakeHttpContext({ tenant: fakeTenant, body: chatBody })

    await controller.chat(ctx)
    await new Promise<void>((resolve) => setImmediate(resolve))

    const detected = captured.filter((c) => c.id === 'guard.ai_injection_detected')
    assert.lengthOf(detected, 1)
    assert.equal(detected[0]!.severity, 'high')
    assert.equal(detected[0]!.tenantId, 't1')
    assert.deepEqual(detected[0]!.metadata, { origin: 'user' })
  })

  test('a classifier THROW is fail-open by default: the request proceeds', async ({ assert }) => {
    const { controller, provider, metrics } = build({
      injection: {
        classifier: () => {
          throw new Error('moderation endpoint had a bad minute')
        },
      },
    })
    const { ctx, res } = fakeHttpContext({ tenant: fakeTenant, body: chatBody })

    await controller.chat(ctx)

    assert.lengthOf(provider.calls, 1, 'fail-open: the stream runs')
    assert.isTrue(res.flushed, 'the stream committed (headers flushed)')
    assert.include(res.output, 'hello')
    assert.include(metricNames(metrics), 'ai_injection_detector_error')
    assert.notInclude(metricNames(metrics), 'ai_injection_detected')
  })

  test('a malformed verdict is fail-open by default (treated as a detector error)', async ({
    assert,
  }) => {
    const { controller, provider, metrics } = build({
      injection: { classifier: () => ({ notAVerdict: true }) as never },
    })
    const { ctx } = fakeHttpContext({ tenant: fakeTenant, body: chatBody })

    await controller.chat(ctx)

    assert.lengthOf(provider.calls, 1)
    assert.include(metricNames(metrics), 'ai_injection_detector_error')
  })

  test('onError:closed refuses on a classifier error (availability coupled knowingly)', async ({
    assert,
  }) => {
    const quota = new FakeQuota()
    quota.reserveError = new Error('reserve must not run when the detector is closed')
    const { controller, provider } = build({
      quota,
      injection: {
        onError: 'closed',
        classifier: () => {
          throw new Error('down')
        },
      },
    })
    const { ctx, res, responseFacade } = fakeHttpContext({ tenant: fakeTenant, body: chatBody })

    await controller.chat(ctx)

    assert.equal(responseFacade.sentStatus, 400)
    assert.deepEqual(responseFacade.sentBody, { error: 'injection_detected' })
    assert.isFalse(res.flushed)
    assert.lengthOf(provider.calls, 0)
  })

  test('an allow verdict proceeds normally', async ({ assert }) => {
    const { controller, provider, metrics } = build({
      injection: { classifier: () => ({ action: 'allow' }) },
    })
    const { ctx } = fakeHttpContext({ tenant: fakeTenant, body: chatBody })

    await controller.chat(ctx)

    assert.lengthOf(provider.calls, 1)
    assert.notInclude(metricNames(metrics), 'ai_injection_detected')
    assert.notInclude(metricNames(metrics), 'ai_injection_detector_error')
  })

  test('with no injection block the classifier never runs; the stream is unchanged', async ({
    assert,
  }) => {
    // Turning the seam off changes nothing about the request path. The boundary was
    // never the classifier (structural role separation is), so an absent block is the
    // correct, no-theater default.
    const { controller, provider, metrics } = build({})
    const { ctx, res } = fakeHttpContext({ tenant: fakeTenant, body: chatBody })

    await controller.chat(ctx)

    assert.lengthOf(provider.calls, 1)
    assert.isTrue(res.flushed)
    assert.include(res.output, 'hello')
    assert.deepEqual(metrics, [], 'no injection metric fires when the seam is absent')
  })
})

/**
 * The seam logic in isolation: origins, the block throw's shape, and the fail
 * posture split, without the controller. `enforceInjectionClassifier` is the one
 * choke every consumer routes through.
 */
test.group('enforceInjectionClassifier: seam logic', () => {
  const ctx = {} as never
  const userInput: InjectionInput[] = [{ text: 'hi', origin: 'user' }]

  test('an absent classifier is a no-op (structural boundary is the only default)', async ({
    assert,
  }) => {
    await enforceInjectionClassifier(ctx, fakeTenant, undefined, userInput)
    await enforceInjectionClassifier(ctx, fakeTenant, {}, userInput)
    assert.isTrue(true)
  })

  test('a block verdict throws a fatal 400 injection_detected', async ({ assert }) => {
    let threw: unknown
    try {
      await enforceInjectionClassifier(
        ctx,
        fakeTenant,
        { classifier: () => ({ action: 'block' }) },
        [{ text: 'evil', origin: 'retrieved' }]
      )
    } catch (err) {
      threw = err
    }
    assert.instanceOf(threw, AIException)
    assert.equal((threw as AIException).aiCode, 'injection_detected')
    assert.equal((threw as AIException).httpStatus, 400)
    assert.isFalse((threw as AIException).isRetryable(), 'a block never becomes correct on retry')
  })

  test('the classifier sees each origin (user / retrieved / tool)', async ({ assert }) => {
    const seen: string[] = []
    await enforceInjectionClassifier(
      ctx,
      fakeTenant,
      {
        classifier: (_c, _t, input) => {
          seen.push(input.origin)
          return { action: 'allow' }
        },
      },
      [
        { text: 'a', origin: 'user' },
        { text: 'b', origin: 'retrieved' },
        { text: 'c', origin: 'tool' },
      ]
    )
    assert.deepEqual(seen, ['user', 'retrieved', 'tool'])
  })

  test('an async classifier is awaited (input-side, so async is free)', async ({ assert }) => {
    let threw: unknown
    try {
      await enforceInjectionClassifier(
        ctx,
        fakeTenant,
        {
          classifier: async () => {
            await Promise.resolve()
            return { action: 'block' }
          },
        },
        userInput
      )
    } catch (err) {
      threw = err
    }
    assert.instanceOf(threw, AIException)
    assert.equal((threw as AIException).aiCode, 'injection_detected')
  })

  test('a codedError reserve sentinel is never reached when a block fires first', async ({
    assert,
  }) => {
    // Sanity: the seam throws synchronously enough that a caller can rely on it
    // firing before any downstream cost (mirrors codedError use in the spend rails).
    const sentinel = codedError('E_SHOULD_NOT_REACH')
    let threw: unknown
    try {
      await enforceInjectionClassifier(
        ctx,
        fakeTenant,
        {
          classifier: () => {
            throw sentinel
          },
          onError: 'closed',
        },
        userInput
      )
    } catch (err) {
      threw = err
    }
    // The classifier's OWN error is swallowed and remapped to injection_detected,
    // never surfaced raw.
    assert.instanceOf(threw, AIException)
    assert.notStrictEqual(threw, sentinel)
  })
})
