import { test } from '@japa/runner'
import AiChatController from '../../../../src/gateway/ai_chat_controller.js'
import AIProviderRegistry from '../../../../src/services/ai_provider_registry.js'
import TenantLivenessWatcher from '../../../../src/services/tenant_liveness_watcher.js'
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
 * G5 (drop the connection, dodge the settle) at the controller: a client
 * hangup mid-stream travels the real `onRequestDisconnect` seam (a `close`
 * on the raw request while the response is unfinished), aborts the pump as
 * client_disconnect, and the finally STILL settles what was streamed.
 */

function disconnectingProvider(onFirstFragment: () => void): AIProviderContract {
  return {
    name: 'claude',
    contractVersion: 2,
    capabilities: { streaming: true },
    async verifyConfig() {},
    async *stream(_request, signal): AsyncIterable<StreamFragment> {
      yield { data: 'first', tokens: 2 }
      onFirstFragment()
      if (signal.aborted) return
      yield { data: 'never-delivered', tokens: 2 }
    },
  }
}

test.group('client disconnect mid-stream (controller)', () => {
  test('a raw-socket close mid-stream aborts as client_disconnect and still settles', async ({
    assert,
  }) => {
    const { ctx, res, rawRequest } = fakeHttpContext({
      tenant: fakeTenant,
      body: { messages: [{ role: 'user', content: 'hola' }] },
    })
    const quota = new FakeQuota()
    const { svc } = makeService(quota)
    const registry = new AIProviderRegistry()
    registry.register(
      disconnectingProvider(() => rawRequest.emitClose()),
      { activate: true }
    )
    const controller = new AiChatController({
      stream: svc,
      registry,
      idempotency: new AiIdempotencyService({
        store: { get: async () => undefined, set: async () => {} },
        macKey: deriveAiIdempotencyMacKey('test-app-key'),
      }),
      liveness: new TenantLivenessWatcher(),
      config: { allowedProviders: ['claude'], authorizeAIAccess: () => true } as AiConfig,
    })

    await controller.chat(ctx)

    assert.include(res.output, 'data: first')
    assert.notInclude(res.output, 'never-delivered')
    assert.include(
      res.output,
      'event: done\ndata: {"outcome":"aborted","reason":"client_disconnect"}'
    )
    assert.deepEqual(quota.settles.at(-1), 2, 'the streamed tokens were settled in the finally')
    assert.equal(quota.releases, 1)
    assert.equal(
      rawRequest.listenerCount('close'),
      0,
      'the disconnect listener was disposed (no raw-socket listener leaks)'
    )
  })
})
