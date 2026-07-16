import { test } from '@japa/runner'
import AiEmbedController from '../../../../src/gateway/ai_embed_controller.js'
import TenantLivenessWatcher from '../../../../src/services/tenant_liveness_watcher.js'
import type EmbeddingIngestionService from '../../../../src/services/embedding_ingestion_service.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import { fakeHttpContext } from '../../../helpers/fake_http_context.js'
import { fakeTenant } from '../../../helpers/stream_doubles.js'
import type {
  AiEmbeddingAuditEvent,
  AiEmbeddingAuditSink,
} from '../../../../src/gateway/audit_seam.js'
import type { AiConfig } from '../../../../src/define_config.js'
import type { IngestionResult } from '../../../../src/services/embedding_ingestion_service.js'

const config = {
  allowedProviders: ['claude'],
  authorizeAIAccess: () => true,
  embedding: { authorizeIngestion: () => true },
} as unknown as AiConfig

function fakeIngestion(onIngest: () => Promise<IngestionResult>): {
  service: EmbeddingIngestionService
  state: { calls: number }
} {
  const state = { calls: 0 }
  const service = {
    providerFingerprint: 'fp-123',
    async ingest() {
      state.calls += 1
      return onIngest()
    },
  } as unknown as EmbeddingIngestionService
  return { service, state }
}

function auditRecorder(): { sink: AiEmbeddingAuditSink; events: AiEmbeddingAuditEvent[] } {
  const events: AiEmbeddingAuditEvent[] = []
  return { sink: { append: (e) => void events.push(e) }, events }
}

const okResult: IngestionResult = {
  ids: ['id-1'],
  count: 1,
  inserted: 1,
  model: 'text-embed',
  dimension: 4,
  tokens: 9,
}

test.group('AiEmbedController', () => {
  test('a valid ingest returns a JSON result and audits completed', async ({ assert }) => {
    const { service } = fakeIngestion(async () => okResult)
    const { sink, events } = auditRecorder()
    const controller = new AiEmbedController({
      ingestion: service,
      liveness: new TenantLivenessWatcher(),
      config,
      audit: sink,
    })
    const { ctx, responseFacade } = fakeHttpContext({
      tenant: fakeTenant,
      body: { source: 'doc-1', input: ['hello world'] },
      auth: { user: { id: 'u1' } },
    })

    await controller.embed(ctx)

    assert.equal(responseFacade.sentStatus, 200)
    assert.deepEqual(responseFacade.sentBody, {
      ids: ['id-1'],
      count: 1,
      inserted: 1,
      model: 'text-embed',
      dimension: 4,
    })
    assert.lengthOf(events, 1)
    assert.equal(events[0].outcome, 'completed')
    assert.equal(events[0].embeddingsCount, 1)
    assert.equal(events[0].tokens, 9)
    assert.match(events[0].actorHash!, /^[0-9a-f]{64}$/)
  })

  test('an AIException from ingestion maps to its status and audits failed', async ({ assert }) => {
    const { service } = fakeIngestion(async () => {
      throw new AIException('embedding_quota_exhausted', 'at the plan limit embeddingCount')
    })
    const { sink, events } = auditRecorder()
    const controller = new AiEmbedController({
      ingestion: service,
      liveness: new TenantLivenessWatcher(),
      config,
      audit: sink,
    })
    const { ctx, responseFacade } = fakeHttpContext({
      tenant: fakeTenant,
      body: { source: 'doc-1', input: ['hello'] },
    })

    await controller.embed(ctx)

    assert.equal(responseFacade.sentStatus, 402)
    assert.deepEqual(responseFacade.sentBody, { error: 'embedding_quota_exhausted' })
    assert.equal(events[0].outcome, 'failed_preflight')
    assert.equal(events[0].reason, 'embedding_quota_exhausted')
  })

  test('a malformed body is rejected before the ingestion runs', async ({ assert }) => {
    const { service } = fakeIngestion(async () => okResult)
    const controller = new AiEmbedController({
      ingestion: service,
      liveness: new TenantLivenessWatcher(),
      config,
    })
    const { ctx } = fakeHttpContext({ tenant: fakeTenant, body: { source: '', input: [] } })
    await assert.rejects(() => controller.embed(ctx), /source must be a non-empty string/)
  })
})
