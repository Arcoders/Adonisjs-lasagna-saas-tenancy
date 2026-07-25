import { test } from '@japa/runner'
import AiRetrieveController from '../../../../src/gateway/ai_retrieve_controller.js'
import AiEmbedController from '../../../../src/gateway/ai_embed_controller.js'
import TenantLivenessWatcher from '../../../../src/services/tenant_liveness_watcher.js'
import type RetrievalService from '../../../../src/services/retrieval_service.js'
import type EmbeddingIngestionService from '../../../../src/services/embedding_ingestion_service.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import { fakeHttpContext } from '../../../helpers/fake_http_context.js'
import { fakeTenant } from '../../../helpers/stream_doubles.js'
import {
  __resetAiGuardCounters,
  __resetAiGuardRateLimit,
  __setAiGuardDispatcherForTests,
} from '../../../../src/isthmus/ai_guard_audit.js'
import type { IsthmusGuardTrippedPayload } from '@adonisjs-lasagna/saas-tenancy/types'
import type { AiConfig } from '../../../../src/define_config.js'

/**
 * No user content leaks into an error, a guard event, an audit row,
 * or a response body. Content-in-audit-rows and the seam fields are pinned elsewhere
 * (the security_audit_seam_*_non_pii and security_ai_audit_persisted_row_non_pii
 * specs); the no-log surface is pinned statically by check-ai-no-prompt-logging. This
 * is the POSITIVE complement: drive the retrieve + embed controllers with a unique
 * canary as the user's query/content, force representative failures, and sweep every
 * observable surface the controller touches, asserting the canary never appears.
 *
 * Metrics are not swept here because they cannot carry content by type
 * (MetricsService.emitMetric(tenantId, name, value: number) takes integers only).
 */

const CANARY = 'CANARY-c0nf1dent1al-user-secret-42-do-not-leak'
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Flatten an error's message and its whole `cause` chain into one searchable string. */
function errorText(err: unknown): string {
  const parts: string[] = []
  let cur: unknown = err
  for (let i = 0; i < 8 && cur; i++) {
    parts.push(String(cur))
    if (cur instanceof Error && cur.message) parts.push(cur.message)
    cur = cur instanceof Error ? (cur as { cause?: unknown }).cause : undefined
  }
  return parts.join('\n')
}

test.group('AI no-content-leak in error / guard / audit surfaces', (group) => {
  let guards: IsthmusGuardTrippedPayload[] = []

  group.each.setup(() => {
    guards = []
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
    __setAiGuardDispatcherForTests(async (payload) => {
      guards.push(payload)
    })
  })

  group.each.teardown(() => {
    __setAiGuardDispatcherForTests(undefined)
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
  })

  /** Every observable string the controller could have leaked content into, labelled. */
  function surfaces(s: {
    thrown?: unknown
    body?: unknown
    audits?: unknown[]
  }): [string, string][] {
    const out: [string, string][] = []
    if (s.thrown !== undefined) out.push(['error/cause chain', errorText(s.thrown)])
    if (s.body !== undefined) out.push(['response body', JSON.stringify(s.body)])
    for (const record of s.audits ?? []) out.push(['audit record', JSON.stringify(record)])
    for (const g of guards) out.push(['guard event', JSON.stringify(g)])
    return out
  }

  // --- retrieve controller (canary = the query) ---

  test('retrieve: an over-length query fails as invalid_request naming the field, never the query', async ({
    assert,
  }) => {
    const service = {
      providerFingerprint: 'fp',
      async retrieve() {},
    } as unknown as RetrievalService
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: { query: CANARY.repeat(2000) },
      auth: { user: { id: 'u1' } },
    })
    let thrown: unknown
    try {
      await buildRetrieve(service).retrieve(ctx)
    } catch (err) {
      thrown = err
    }
    await settle()
    assert.instanceOf(thrown, AIException)
    assert.equal((thrown as AIException).aiCode, 'invalid_request')
    for (const [label, text] of surfaces({ thrown }))
      assert.notInclude(text, CANARY, `${label} leaked the content`)
  })

  test('retrieve: a coded AIException (over_budget) leaks nothing into body or audit', async ({
    assert,
  }) => {
    const audits: unknown[] = []
    const service = {
      providerFingerprint: 'fp',
      async retrieve() {
        throw new AIException('over_budget', 'the ai cost governor rejected the reservation')
      },
    } as unknown as RetrievalService
    const { ctx, responseFacade } = fakeHttpContext({
      tenant: fakeTenant,
      body: { query: CANARY },
      auth: { user: { id: 'u1' } },
    })
    await buildRetrieve(service, audits).retrieve(ctx)
    await settle()
    assert.equal(responseFacade.sentStatus, 402)
    for (const [label, text] of surfaces({ body: responseFacade.sentBody, audits }))
      assert.notInclude(text, CANARY, `${label} leaked the content`)
  })

  test('retrieve: a RAW store outage re-throws without wrapping the query', async ({ assert }) => {
    const audits: unknown[] = []
    const outage = new Error('embeddings connection reset by peer')
    const service = {
      providerFingerprint: 'fp',
      async retrieve() {
        throw outage
      },
    } as unknown as RetrievalService
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: { query: CANARY },
      auth: { user: { id: 'u1' } },
    })
    let thrown: unknown
    try {
      await buildRetrieve(service, audits).retrieve(ctx)
    } catch (err) {
      thrown = err
    }
    await settle()
    assert.equal(thrown, outage, 'the raw outage propagates unchanged')
    for (const [label, text] of surfaces({ thrown, audits }))
      assert.notInclude(text, CANARY, `${label} leaked the content`)
  })

  // --- embed controller (canary = the document content) ---

  test('embed: an over-length chunk fails as invalid_request naming the index, never the content', async ({
    assert,
  }) => {
    const service = {
      providerFingerprint: 'fp',
      async ingest() {},
    } as unknown as EmbeddingIngestionService
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: { source: 'doc-1', input: [CANARY.repeat(3000)] },
      auth: { user: { id: 'u1' } },
    })
    let thrown: unknown
    try {
      await buildEmbed(service).embed(ctx)
    } catch (err) {
      thrown = err
    }
    await settle()
    assert.instanceOf(thrown, AIException)
    assert.equal((thrown as AIException).aiCode, 'invalid_request')
    for (const [label, text] of surfaces({ thrown }))
      assert.notInclude(text, CANARY, `${label} leaked the content`)
  })

  test('embed: a denied ingestion emits a guard with no content in its metadata', async ({
    assert,
  }) => {
    const service = {
      providerFingerprint: 'fp',
      async ingest() {},
    } as unknown as EmbeddingIngestionService
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: { source: 'doc-1', input: [CANARY] },
      auth: { user: { id: 'u1' } },
    })
    let thrown: unknown
    try {
      await buildEmbed(service, [], {
        embedding: { authorizeIngestion: () => false } as never,
      }).embed(ctx)
    } catch (err) {
      thrown = err
    }
    await settle()
    assert.instanceOf(thrown, AIException)
    assert.equal((thrown as AIException).aiCode, 'ingestion_denied')
    assert.isAtLeast(guards.length, 1)
    for (const [label, text] of surfaces({ thrown }))
      assert.notInclude(text, CANARY, `${label} leaked the content`)
  })

  test('embed: a coded ingest failure (dimension_mismatch) leaks nothing into body or audit', async ({
    assert,
  }) => {
    const audits: unknown[] = []
    const service = {
      providerFingerprint: 'fp',
      async ingest() {
        throw new AIException('dimension_mismatch', 'embedding dimension does not match the index')
      },
    } as unknown as EmbeddingIngestionService
    const { ctx, responseFacade } = fakeHttpContext({
      tenant: fakeTenant,
      body: { source: 'doc-1', input: [CANARY] },
      auth: { user: { id: 'u1' } },
    })
    await buildEmbed(service, audits).embed(ctx)
    await settle()
    assert.equal(responseFacade.sentStatus, 400)
    for (const [label, text] of surfaces({ body: responseFacade.sentBody, audits }))
      assert.notInclude(text, CANARY, `${label} leaked the content`)
  })
})

// --- builders ---

function buildRetrieve(service: RetrievalService, audits: unknown[] = []): AiRetrieveController {
  return new AiRetrieveController({
    retrieval: service,
    liveness: new TenantLivenessWatcher(),
    config: {
      allowedProviders: ['claude'],
      authorizeAIAccess: () => true,
      acknowledgeUnscopedRetrieval: true,
    } as AiConfig,
    audit: { append: async (r: unknown) => void audits.push(r) } as never,
  })
}

function buildEmbed(
  service: EmbeddingIngestionService,
  audits: unknown[] = [],
  over: Partial<AiConfig> = {}
): AiEmbedController {
  return new AiEmbedController({
    ingestion: service,
    liveness: new TenantLivenessWatcher(),
    config: {
      allowedProviders: ['claude'],
      authorizeAIAccess: () => true,
      ...over,
    } as AiConfig,
    audit: { append: async (r: unknown) => void audits.push(r) } as never,
  })
}
