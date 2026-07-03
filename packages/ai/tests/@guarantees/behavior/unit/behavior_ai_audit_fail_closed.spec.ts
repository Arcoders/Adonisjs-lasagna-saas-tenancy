import { test } from '@japa/runner'
import AiEmbedController from '../../../../src/gateway/ai_embed_controller.js'
import AiRetrieveController from '../../../../src/gateway/ai_retrieve_controller.js'
import TenantLivenessWatcher from '../../../../src/services/tenant_liveness_watcher.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import { fakeHttpContext } from '../../../helpers/fake_http_context.js'
import { fakeTenant } from '../../../helpers/stream_doubles.js'
import type { AiConfig } from '../../../../src/define_config.js'
import type EmbeddingIngestionService from '../../../../src/services/embedding_ingestion_service.js'
import type RetrievalService from '../../../../src/services/retrieval_service.js'
import type { AiEmbeddingAuditSink, AiRetrievalAuditSink } from '../../../../src/gateway/audit_seam.js'

/** A sink standing in for the DB-backed writer during an audit-DB outage. */
function downAudit<T>(): T {
  return {
    async append() {
      throw new AIException(
        'audit_write_failed',
        'Refusing to complete the request: the AI audit row could not be written.'
      )
    },
  } as unknown as T
}

const embedConfig = {
  allowedProviders: ['claude'],
  authorizeAIAccess: () => true,
  embedding: { authorizeIngestion: () => true },
} as unknown as AiConfig

// Retrieval is fail-closed by default (C9); acknowledge the tenant-wide posture so
// the request reaches the success path where the audit write matters.
const retrieveConfig = {
  allowedProviders: ['claude'],
  authorizeAIAccess: () => true,
  embedding: {},
  acknowledgeUnscopedRetrieval: true,
} as unknown as AiConfig

const okIngest = {
  providerFingerprint: 'fp',
  async ingest() {
    return { ids: ['i'], count: 1, inserted: 1, model: 'text-embed', dimension: 4, tokens: 9 }
  },
} as unknown as EmbeddingIngestionService

const okRetrieve = {
  providerFingerprint: 'fp',
  async retrieve() {
    return {
      matches: [{ id: 'm', content: 'c', metadata: {}, distance: 0.1 }],
      model: 'text-embed',
      tokens: 3,
    }
  },
} as unknown as RetrievalService

test.group('behavior — AI audit fail-closed at the pre-response controllers', () => {
  test('an audit-write outage on a completed embed is a fail-closed 503, not a silent 200', async ({
    assert,
  }) => {
    const controller = new AiEmbedController({
      ingestion: okIngest,
      liveness: new TenantLivenessWatcher(),
      config: embedConfig,
      audit: downAudit<AiEmbeddingAuditSink>(),
    })
    const { ctx, responseFacade } = fakeHttpContext({
      tenant: fakeTenant,
      body: { source: 'd', input: ['x'] },
      auth: { user: { id: 'u' } },
    })
    await controller.embed(ctx)
    assert.equal(responseFacade.sentStatus, 503)
    assert.deepEqual(responseFacade.sentBody, { error: 'audit_write_failed' })
  })

  test('an audit-write outage on a completed retrieve is a fail-closed 503', async ({ assert }) => {
    const controller = new AiRetrieveController({
      retrieval: okRetrieve,
      liveness: new TenantLivenessWatcher(),
      config: retrieveConfig,
      audit: downAudit<AiRetrievalAuditSink>(),
    })
    const { ctx, responseFacade } = fakeHttpContext({
      tenant: fakeTenant,
      body: { query: 'q' },
      auth: { user: { id: 'u' } },
    })
    await controller.retrieve(ctx)
    assert.equal(responseFacade.sentStatus, 503)
    assert.deepEqual(responseFacade.sentBody, { error: 'audit_write_failed' })
  })

  test('a genuine ingest failure keeps its own status; the best-effort failure-audit never masks it', async ({
    assert,
  }) => {
    const overBudget = {
      providerFingerprint: 'fp',
      async ingest() {
        throw new AIException('over_budget', 'at the plan budget')
      },
    } as unknown as EmbeddingIngestionService
    const controller = new AiEmbedController({
      ingestion: overBudget,
      liveness: new TenantLivenessWatcher(),
      config: embedConfig,
      audit: downAudit<AiEmbeddingAuditSink>(),
    })
    const { ctx, responseFacade } = fakeHttpContext({
      tenant: fakeTenant,
      body: { source: 'd', input: ['x'] },
    })
    await controller.embed(ctx)
    assert.equal(responseFacade.sentStatus, 402)
    assert.deepEqual(responseFacade.sentBody, { error: 'over_budget' })
  })
})
