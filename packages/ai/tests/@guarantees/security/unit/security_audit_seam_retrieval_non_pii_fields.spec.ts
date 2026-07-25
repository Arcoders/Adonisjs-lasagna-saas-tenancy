import { test } from '@japa/runner'
import AiRetrieveController from '../../../../src/gateway/ai_retrieve_controller.js'
import TenantLivenessWatcher from '../../../../src/services/tenant_liveness_watcher.js'
import type RetrievalService from '../../../../src/services/retrieval_service.js'
import {
  hashAuditPrincipal,
  type AiRetrievalAuditEvent,
  type AiRetrievalAuditSink,
} from '../../../../src/gateway/audit_seam.js'
import { fakeHttpContext } from '../../../helpers/fake_http_context.js'
import { fakeTenant } from '../../../helpers/stream_doubles.js'
import type { AiConfig } from '../../../../src/define_config.js'

/**
 * The retrieve choke point's own forward contract: the retrieval audit event field set
 * is pinned EXACTLY (a parallel event to the chat/embed ones), `actorHash` is one-way,
 * and neither the query text nor a returned document ever reaches a serialized event
 * (only a `matchCount`).
 */
const PINNED_FIELDS = [
  'actorHash',
  'matchCount',
  'model',
  'occurredAt',
  'outcome',
  'reason',
  'tenantId',
  'tokens',
]

const SECRET_QUERY = 'the-secret-query-text'
const SECRET_DOC = 'the-secret-retrieved-document'

function capturingSink() {
  const events: AiRetrievalAuditEvent[] = []
  const sink: AiRetrievalAuditSink = { append: (event) => void events.push(event) }
  return { sink, events }
}

function buildController(sink: AiRetrievalAuditSink) {
  const retrieval = {
    providerFingerprint: 'fp',
    async retrieve() {
      return {
        matches: [{ id: 'm1', content: SECRET_DOC, metadata: {}, distance: 0.1 }],
        model: 'text-embed',
        tokens: 7,
      }
    },
  } as unknown as RetrievalService
  return new AiRetrieveController({
    retrieval,
    liveness: new TenantLivenessWatcher(),
    // This spec pins the audit event fields, not the fail-closed ACL posture, so
    // acknowledge the unscoped default to let a retrieval complete and be audited.
    config: {
      allowedProviders: ['claude'],
      authorizeAIAccess: () => true,
      acknowledgeUnscopedRetrieval: true,
    } as AiConfig,
    audit: sink,
  })
}

test.group('retrieval audit seam non-PII contract', () => {
  test('a completed retrieval lands exactly one event with the pinned field set', async ({
    assert,
  }) => {
    const { sink, events } = capturingSink()
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: { query: SECRET_QUERY },
      auth: { user: { id: 'user-1' } },
    })

    await buildController(sink).retrieve(ctx)

    assert.lengthOf(events, 1)
    assert.deepEqual(
      Object.keys(events[0]!).sort(),
      PINNED_FIELDS,
      'the retrieval audit event field set is FROZEN; extending it is a reviewed decision'
    )
    assert.equal(events[0]!.outcome, 'completed')
    assert.equal(events[0]!.tenantId, 't1')
    assert.equal(events[0]!.matchCount, 1)
    assert.equal(events[0]!.tokens, 7)
  })

  test('the actor is one-way hashed and neither the query nor a document leaks', async ({
    assert,
  }) => {
    const { sink, events } = capturingSink()
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: { query: SECRET_QUERY },
      auth: { user: { id: 'user-1' } },
    })

    await buildController(sink).retrieve(ctx)

    assert.equal(events[0]!.actorHash, hashAuditPrincipal('user-1'))
    assert.match(events[0]!.actorHash!, /^[0-9a-f]{64}$/)
    const serialized = JSON.stringify(events)
    assert.notInclude(serialized, 'user-1')
    assert.notInclude(serialized, SECRET_QUERY)
    assert.notInclude(serialized, SECRET_DOC)
  })

  test('an anonymous retrieval lands a null actorHash', async ({ assert }) => {
    const { sink, events } = capturingSink()
    const { ctx } = fakeHttpContext({ tenant: fakeTenant, body: { query: SECRET_QUERY } })
    await buildController(sink).retrieve(ctx)
    assert.isNull(events[0]!.actorHash)
  })
})
