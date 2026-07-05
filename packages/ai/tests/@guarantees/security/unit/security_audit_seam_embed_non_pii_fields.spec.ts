import { test } from '@japa/runner'
import AiEmbedController from '../../../../src/gateway/ai_embed_controller.js'
import TenantLivenessWatcher from '../../../../src/services/tenant_liveness_watcher.js'
import type EmbeddingIngestionService from '../../../../src/services/embedding_ingestion_service.js'
import {
  hashAuditPrincipal,
  type AiEmbeddingAuditEvent,
  type AiEmbeddingAuditSink,
} from '../../../../src/gateway/audit_seam.js'
import { fakeHttpContext } from '../../../helpers/fake_http_context.js'
import { fakeTenant } from '../../../helpers/stream_doubles.js'
import type { AiConfig } from '../../../../src/define_config.js'

/**
 * The embed choke point's own G1 forward contract: the embed audit event field
 * set is pinned EXACTLY (a parallel event to the chat one, so extending either
 * is an isolated reviewed decision), `actorHash`/`sourceHash` are one-way, and
 * no embedded text ever reaches a serialized event.
 */
const PINNED_FIELDS = [
  'actorHash',
  'dimension',
  'embeddingsCount',
  'model',
  'occurredAt',
  'outcome',
  'reason',
  'sourceHash',
  'tenantId',
  'tokens',
]

const SECRET = 'the-secret-embedded-text'

function capturingSink() {
  const events: AiEmbeddingAuditEvent[] = []
  const sink: AiEmbeddingAuditSink = { append: (event) => void events.push(event) }
  return { sink, events }
}

function buildController(sink: AiEmbeddingAuditSink) {
  const ingestion = {
    providerFingerprint: 'fp',
    async ingest() {
      return { ids: ['id-1'], count: 1, inserted: 1, model: 'text-embed', dimension: 4, tokens: 7 }
    },
  } as unknown as EmbeddingIngestionService
  return new AiEmbedController({
    ingestion,
    liveness: new TenantLivenessWatcher(),
    config: { allowedProviders: ['claude'], authorizeAIAccess: () => true } as AiConfig,
    audit: sink,
  })
}

test.group('embed audit seam non-PII contract', () => {
  test('a completed ingest lands exactly one event with the pinned field set', async ({
    assert,
  }) => {
    const { sink, events } = capturingSink()
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: { source: 'my-doc', input: [SECRET] },
      auth: { user: { id: 'user-1' } },
    })

    await buildController(sink).embed(ctx)

    assert.lengthOf(events, 1)
    assert.deepEqual(
      Object.keys(events[0]).sort(),
      PINNED_FIELDS,
      'the embed audit event field set is FROZEN; extending it is a reviewed decision'
    )
    assert.equal(events[0].outcome, 'completed')
    assert.equal(events[0].tenantId, 't1')
    assert.equal(events[0].embeddingsCount, 1)
    assert.equal(events[0].dimension, 4)
  })

  test('actor and source are one-way hashed, never raw, and no content leaks', async ({
    assert,
  }) => {
    const { sink, events } = capturingSink()
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: { source: 'my-doc', input: [SECRET] },
      auth: { user: { id: 'user-1' } },
    })

    await buildController(sink).embed(ctx)

    assert.equal(events[0].actorHash, hashAuditPrincipal('user-1'))
    assert.equal(events[0].sourceHash, hashAuditPrincipal('my-doc'))
    assert.match(events[0].actorHash!, /^[0-9a-f]{64}$/)
    const serialized = JSON.stringify(events)
    assert.notInclude(serialized, 'user-1')
    assert.notInclude(serialized, 'my-doc')
    assert.notInclude(serialized, SECRET)
  })

  test('an anonymous ingest lands a null actorHash', async ({ assert }) => {
    const { sink, events } = capturingSink()
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: { source: 'my-doc', input: [SECRET] },
    })
    await buildController(sink).embed(ctx)
    assert.isNull(events[0].actorHash)
  })
})
