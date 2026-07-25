import { test } from '@japa/runner'
import AiRetrieveController from '../../../../src/gateway/ai_retrieve_controller.js'
import TenantLivenessWatcher from '../../../../src/services/tenant_liveness_watcher.js'
import type RetrievalService from '../../../../src/services/retrieval_service.js'
import { fakeHttpContext } from '../../../helpers/fake_http_context.js'
import { fakeTenant } from '../../../helpers/stream_doubles.js'
import type { AiConfig } from '../../../../src/define_config.js'

/**
 * The retrieve choke point authorizes FIRST (like embed): a caller denied by the
 * membership gate OR by the retrievalFilter document ACL never reaches the
 * retrieval service, so no reservation is taken and no query is embedded (a
 * denied caller spends nothing).
 */
function retrievalSpy(): { service: RetrievalService; state: { calls: number } } {
  const state = { calls: 0 }
  const service = {
    providerFingerprint: 'fp',
    async retrieve() {
      state.calls += 1
      return { matches: [], model: 'm', tokens: 0 }
    },
  } as unknown as RetrievalService
  return { service, state }
}

function controllerWith(config: AiConfig) {
  const { service, state } = retrievalSpy()
  const controller = new AiRetrieveController({
    retrieval: service,
    liveness: new TenantLivenessWatcher(),
    config,
  })
  return { controller, state }
}

const body = { query: 'what is our refund policy' }

test.group('AiRetrieveController authorizes before spending', () => {
  test('a denied membership gate reaches neither the reservation nor the embed', async ({
    assert,
  }) => {
    const { controller, state } = controllerWith({
      allowedProviders: ['claude'],
      authorizeAIAccess: () => false,
    } as AiConfig)
    const { ctx } = fakeHttpContext({ tenant: fakeTenant, body, auth: { user: { id: 'u1' } } })
    await assert.rejects(() => controller.retrieve(ctx))
    assert.equal(state.calls, 0)
  })

  test('a retrievalFilter that fails closed (throws) spends nothing', async ({ assert }) => {
    const { controller, state } = controllerWith({
      allowedProviders: ['claude'],
      authorizeAIAccess: () => true,
      retrieval: {
        retrievalFilter: () => {
          throw new Error('acl backend down')
        },
      },
    } as unknown as AiConfig)
    const { ctx } = fakeHttpContext({ tenant: fakeTenant, body, auth: { user: { id: 'u1' } } })
    await assert.rejects(() => controller.retrieve(ctx), /Refusing the retrieval/)
    assert.equal(state.calls, 0)
  })
})
