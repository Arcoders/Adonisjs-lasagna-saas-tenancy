import { test } from '@japa/runner'
import type { Emitter } from '@adonisjs/core/events'
import { TenantSuspended } from '@adonisjs-lasagna/saas-tenancy/events'
import AiChatController from '../../../../src/gateway/ai_chat_controller.js'
import AIProviderRegistry from '../../../../src/services/ai_provider_registry.js'
import TenantLivenessWatcher, {
  wireAiTenantLiveness,
} from '../../../../src/services/tenant_liveness_watcher.js'
import AiIdempotencyService, {
  deriveAiIdempotencyMacKey,
} from '../../../../src/gateway/idempotency.js'
import type {
  AIProviderContract,
  StreamFragment,
} from '../../../../src/types/ai_provider_contract.js'
import { FakeQuota, makeService, fakeTenant } from '../../../helpers/stream_doubles.js'
import { fakeHttpContext } from '../../../helpers/fake_http_context.js'
import type { AiConfig } from '../../../../src/define_config.js'

/**
 * G11 end to end at the controller: a TenantSuspended event mid-stream fires
 * the liveness signal the controller acquired, the spine attributes the abort
 * to tenant_suspended, the terminal done frame names it, and the finally
 * still settled and released the reservation (G5: no cost dodge via
 * suspension timing).
 */

type Handler = (event: unknown) => void

function fakeEmitter() {
  const handlers = new Map<unknown, Handler>()
  const emitter = {
    on(event: unknown, handler: Handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
  } as unknown as Emitter<any>
  const fire = (event: unknown, payload: unknown) => handlers.get(event)?.(payload)
  return { emitter, fire }
}

/** Yields one fragment, triggers the suspension, then keeps honoring the signal. */
function suspendingProvider(onFirstFragment: () => void): AIProviderContract {
  return {
    name: 'claude',
    contractVersion: 2,
    capabilities: { streaming: true },
    async verifyConfig() {},
    async *stream(_request, signal): AsyncIterable<StreamFragment> {
      yield { data: 'first', tokens: 1 }
      onFirstFragment()
      if (signal.aborted) return
      yield { data: 'never-delivered', tokens: 1 }
    },
  }
}

test.group('suspend mid-stream (controller)', () => {
  test('a TenantSuspended dispatch aborts the live stream as tenant_suspended', async ({
    assert,
  }) => {
    const watcher = new TenantLivenessWatcher()
    const { emitter, fire } = fakeEmitter()
    wireAiTenantLiveness(emitter, watcher)

    const quota = new FakeQuota()
    const { svc } = makeService(quota)
    const registry = new AIProviderRegistry()
    registry.register(
      suspendingProvider(() => fire(TenantSuspended, { tenant: { id: fakeTenant.id } })),
      { activate: true }
    )
    const controller = new AiChatController({
      stream: svc,
      registry,
      idempotency: new AiIdempotencyService({
        store: { get: async () => undefined, set: async () => {} },
        macKey: deriveAiIdempotencyMacKey('test-app-key'),
      }),
      liveness: watcher,
      config: { allowedProviders: ['claude'], authorizeAIAccess: () => true } as AiConfig,
    })
    const { ctx, res } = fakeHttpContext({
      tenant: fakeTenant,
      body: { messages: [{ role: 'user', content: 'hola' }] },
    })

    await controller.chat(ctx)

    assert.include(res.output, 'data: first')
    assert.notInclude(res.output, 'never-delivered')
    assert.include(
      res.output,
      'event: done\ndata: {"outcome":"aborted","reason":"tenant_suspended"}'
    )
    assert.isTrue(res.ended)
    assert.isAbove(quota.settles.length, 0, 'the finally still settled the used tokens')
    assert.equal(quota.releases, 1, 'the finally still released the remainder')
    assert.equal(watcher.watchedTenantCount(), 0, 'the liveness handle was disposed')
  })
})
