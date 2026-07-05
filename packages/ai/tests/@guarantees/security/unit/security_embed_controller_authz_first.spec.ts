import { test } from '@japa/runner'
import AiEmbedController from '../../../../src/gateway/ai_embed_controller.js'
import TenantLivenessWatcher from '../../../../src/services/tenant_liveness_watcher.js'
import type EmbeddingIngestionService from '../../../../src/services/embedding_ingestion_service.js'
import { fakeHttpContext } from '../../../helpers/fake_http_context.js'
import { fakeTenant } from '../../../helpers/stream_doubles.js'
import type { AiConfig } from '../../../../src/define_config.js'

/**
 * The embed choke point authorizes FIRST (like chat): a caller denied by the
 * membership gate OR the ingestion write gate never reaches the ingestion
 * service, so no reservation is taken and no provider is called (a denied caller
 * spends nothing).
 */
function ingestionSpy(): { service: EmbeddingIngestionService; state: { calls: number } } {
  const state = { calls: 0 }
  const service = {
    providerFingerprint: 'fp',
    async ingest() {
      state.calls += 1
      return { ids: [], count: 0, inserted: 0, model: 'm', dimension: 4, tokens: 0 }
    },
  } as unknown as EmbeddingIngestionService
  return { service, state }
}

function controllerWith(config: AiConfig) {
  const { service, state } = ingestionSpy()
  const controller = new AiEmbedController({
    ingestion: service,
    liveness: new TenantLivenessWatcher(),
    config,
  })
  return { controller, state }
}

const body = { source: 'doc-1', input: ['hello'] }

test.group('AiEmbedController authorizes before spending', () => {
  test('a denied membership gate reaches neither the reservation nor the provider', async ({
    assert,
  }) => {
    const { controller, state } = controllerWith({
      allowedProviders: ['claude'],
      authorizeAIAccess: () => false,
    } as AiConfig)
    const { ctx } = fakeHttpContext({ tenant: fakeTenant, body, auth: { user: { id: 'u1' } } })
    await assert.rejects(() => controller.embed(ctx))
    assert.equal(state.calls, 0)
  })

  test('a denied ingestion write gate also spends nothing', async ({ assert }) => {
    const { controller, state } = controllerWith({
      allowedProviders: ['claude'],
      authorizeAIAccess: () => true,
      embedding: { authorizeIngestion: () => false },
    } as unknown as AiConfig)
    const { ctx } = fakeHttpContext({ tenant: fakeTenant, body, auth: { user: { id: 'u1' } } })
    await assert.rejects(() => controller.embed(ctx), /Refusing the ingest/)
    assert.equal(state.calls, 0)
  })
})
