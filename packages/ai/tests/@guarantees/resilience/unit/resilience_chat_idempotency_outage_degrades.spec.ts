import { test } from '@japa/runner'
import AiChatController from '../../../../src/gateway/ai_chat_controller.js'
import AIProviderRegistry from '../../../../src/services/ai_provider_registry.js'
import TenantLivenessWatcher from '../../../../src/services/tenant_liveness_watcher.js'
import AiIdempotencyService, {
  deriveAiIdempotencyMacKey,
} from '../../../../src/gateway/idempotency.js'
import type { AiGatewayAuditEvent } from '../../../../src/gateway/audit_seam.js'
import MockAIProvider from '../../../../src/testing/mock_ai_provider.js'
import { makeService, fakeTenant } from '../../../helpers/stream_doubles.js'
import { fakeHttpContext } from '../../../helpers/fake_http_context.js'
import type { AiConfig } from '../../../../src/define_config.js'

/**
 * A dead idempotency store must cost the caller ONLY the replay convenience:
 * the stream runs, completes, audits, and a retry simply streams fresh. The
 * cache is fail-open by contract; the fail-closed rails (mount, authz,
 * reserve) are elsewhere.
 */
test.group('idempotency store outage (controller)', () => {
  test('a throwing store degrades to fresh streams, never an error', async ({ assert }) => {
    const events: AiGatewayAuditEvent[] = []
    const provider = new MockAIProvider({ name: 'claude', contractVersion: 1 })
    const registry = new AIProviderRegistry()
    registry.register(provider, { activate: true })
    const controller = new AiChatController({
      stream: makeService().svc,
      registry,
      idempotency: new AiIdempotencyService({
        store: {
          get: async () => {
            throw new Error('redis down')
          },
          set: async () => {
            throw new Error('redis down')
          },
        },
        macKey: deriveAiIdempotencyMacKey('test-app-key'),
      }),
      liveness: new TenantLivenessWatcher(),
      config: { allowedProviders: ['claude'], authorizeAIAccess: () => true } as AiConfig,
      audit: {
        append: (event) => {
          events.push(event)
        },
      },
    })
    const request = () =>
      fakeHttpContext({
        tenant: fakeTenant,
        body: { messages: [{ role: 'user', content: 'hola' }] },
        headers: { 'idempotency-key': 'retry-1' },
        auth: { user: { id: 'u1' } },
      })

    const first = request()
    await controller.chat(first.ctx)
    const second = request()
    await controller.chat(second.ctx)

    for (const { res } of [first, second]) {
      assert.isTrue(res.output.endsWith('event: done\ndata: {"outcome":"completed"}\n\n'))
      assert.isUndefined(res.headers['x-ai-idempotent-replay'])
    }
    assert.lengthOf(provider.calls, 2, 'no replay was possible, both calls streamed fresh')
    assert.lengthOf(events, 2)
    assert.isTrue(events.every((e) => e.outcome === 'completed' && e.idempotentReplay === false))
  })
})
