import { createHash } from 'node:crypto'
import { SafeFetchError, type SafeFetchOptions } from '@adonisjs-lasagna/saas-tenancy/safe-fetch'
import AIException from '../exceptions/ai_exception.js'
import type { AIErrorCode } from '../exceptions/ai_exception.js'
import {
  AI_TOKENS_QUOTA,
  DEFAULT_INGESTION_MAX_BYTES,
  DEFAULT_INGESTION_TIMEOUT_MS,
  DEFAULT_MAX_EMBEDDING_TOKENS_PER_CHUNK,
  EMBEDDING_COUNT_QUOTA,
} from '../constants.js'
import type VectorStoreService from './vector_store_service.js'
import type { AIEmbeddingProviderContract } from '../types/ai_embedding_contract.js'
import type { AIEmbeddingConfig } from '../define_config.js'
import type { QuotaReservation } from '@adonisjs-lasagna/saas-tenancy/services'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/** The narrow QuotaService surface the non-streaming embed path needs (SEAM-3). */
export interface IngestionQuota {
  reserve(tenant: TenantModelContract, quota: string, worstCase: number): Promise<QuotaReservation>
  settle(reservation: QuotaReservation, cumulativeUsed: number): Promise<void>
  release(reservation: QuotaReservation): Promise<number>
  /** The per-plan ceiling for a quota (Infinity when unset). */
  getLimit(tenant: TenantModelContract, quota: string): Promise<number>
}

/** A validated ingest request. Content bounds + authorization are the controller's job (C6). */
export interface IngestionRequest {
  /** The document / batch key: provenance root and the rollback-by-source unit (#3). */
  readonly source: string
  /** Pre-chunked inline texts to embed (chunking a large doc is the host's job in 1.0). */
  readonly input: readonly string[]
  /** Optional remote document, fetched through the SSRF-pinned fetch and appended as one chunk. */
  readonly sourceUrl?: string
  /** Non-PII metadata stored per row. */
  readonly metadata: Record<string, unknown>
  /** Per-request model override (validated against the provider allow-list). */
  readonly model?: string
  /** The SHA-256 of the authenticated principal (provenance `actor`), never the raw id. */
  readonly actorHash: string | null
}

export interface IngestionResult {
  readonly ids: string[]
  /** Chunks embedded this request. */
  readonly count: number
  /** Rows newly stored (excludes idempotent dedup hits). */
  readonly inserted: number
  readonly model: string
  readonly dimension: number
  /** Provider-reported tokens settled (for the audit trail). */
  readonly tokens: number
}

export interface EmbeddingIngestionDeps {
  store: VectorStoreService
  provider: AIEmbeddingProviderContract
  quota: IngestionQuota
  /** The kernel IP-pinned fetch (safeFetch), for the optional document fetch (#11). */
  fetch: (url: string, opts: SafeFetchOptions) => Promise<Response>
  /** Integer metric sink (MetricsService.emitMetric). */
  emitMetric: (tenantId: string, name: string, value: number) => void
  config: AIEmbeddingConfig | undefined
}

/**
 * The embedding-ingestion orchestrator (WS-AI-3). It runs the fail-closed cost
 * order: resolve the texts (inline + an optional SSRF-pinned document fetch),
 * reserve the worst-case `aiTokens` (a non-streaming call still costs money, so
 * it is metered like a completion), embed, store idempotently under the
 * embeddingCount cap, then settle the actual tokens and always release the hold.
 * Authorization, request-shape validation and idempotency are the controller's
 * (C6) responsibility; this service trusts a validated request and owns the
 * reserve/embed/store/settle machine.
 */
export default class EmbeddingIngestionService {
  constructor(private readonly deps: EmbeddingIngestionDeps) {}

  /** The provider key fingerprint (or its name) for the per-key rate-limit bucket (threat #4). */
  get providerFingerprint(): string {
    return this.deps.provider.keyFingerprint ?? this.deps.provider.name
  }

  async ingest(
    tenant: TenantModelContract,
    request: IngestionRequest,
    signal: AbortSignal
  ): Promise<IngestionResult> {
    const texts = [...request.input]
    if (request.sourceUrl) texts.push(await this.#fetchDocument(request.sourceUrl, signal))
    if (texts.length === 0) {
      throw new AIException('invalid_request', 'an ingest needs a non-empty input or a sourceUrl')
    }

    const perChunk = this.deps.config?.maxEmbeddingTokens ?? DEFAULT_MAX_EMBEDDING_TOKENS_PER_CHUNK
    const worstCase = texts.length * perChunk

    let reservation: QuotaReservation
    try {
      reservation = await this.deps.quota.reserve(tenant, AI_TOKENS_QUOTA, worstCase)
    } catch (error) {
      // Fail-closed by construction: a quota-backend outage is a 503, not a free pass.
      throw new AIException(
        classifyReserveError(error),
        'the ai cost governor rejected the reservation',
        {
          cause: error,
        }
      )
    }

    try {
      const result = await this.deps.provider.embed({ input: texts, model: request.model }, signal)
      const chunks = texts.map((content, i) => ({
        content,
        // The dedup identity folds the model in (not just the content), so a
        // re-ingest of the same content under a DIFFERENT same-dimension model is
        // a fresh row, not a swallowed `ON CONFLICT DO NOTHING` no-op that would
        // leave retrieval under the new model empty. A re-ingest under the SAME
        // model stays idempotent.
        contentHash: dedupHash(result.model, content),
        metadata: request.metadata,
        model: result.model,
        actor: request.actorHash,
        embedding: result.embeddings[i] ?? [],
      }))

      const limit = await this.deps.quota.getLimit(tenant, EMBEDDING_COUNT_QUOTA)
      const stored = await this.deps.store.insert(tenant, request.source, chunks, {
        maxCount: limit,
      })

      await this.deps.quota.settle(reservation, result.tokens)
      this.deps.emitMetric(tenant.id, 'ai_embeddings_ingested', stored.inserted)
      this.deps.emitMetric(tenant.id, 'ai_embedding_tokens_total', result.tokens)

      return {
        ids: stored.ids,
        count: texts.length,
        inserted: stored.inserted,
        model: result.model,
        dimension: result.dimension,
        tokens: result.tokens,
      }
    } catch (error) {
      this.deps.emitMetric(tenant.id, 'ai_embedding_errors', 1)
      throw error
    } finally {
      // Always return the unused hold, whatever happened after the reserve.
      await this.deps.quota.release(reservation).catch(() => {})
    }
  }

  /**
   * Fetch a document through the kernel SSRF-pinned fetch (#11). A private /
   * metadata / loopback URL is refused by the pin (SafeFetchError) and surfaced
   * as `doc_fetch_blocked`; the kernel guard is the enforcer, so this site is on
   * the no-silent allowlist rather than emitting a duplicate satellite guard.
   *
   * The body is STREAMED (`streaming: true`) and drained under a running byte cap
   * so the transfer is aborted the instant it crosses `ingestionMaxBytes`; it is
   * never buffered whole first, so a hostile public host (one that passes the
   * IP-pin, exactly threat #11's model) cannot OOM the worker with a multi-GB
   * body. A separate `ingestionTimeoutMs` bounds a slow / hung upstream.
   */
  async #fetchDocument(url: string, signal: AbortSignal): Promise<string> {
    const timeoutMs = this.deps.config?.ingestionTimeoutMs ?? DEFAULT_INGESTION_TIMEOUT_MS
    let response: Response
    try {
      response = await this.deps.fetch(url, { streaming: true, timeoutMs, signal })
    } catch (error) {
      if (error instanceof SafeFetchError) {
        // The kernel SSRF pin already counted this rejection; the satellite maps
        // it to a fatal 400 without a duplicate guard event (as base_provider does
        // for byok_endpoint_blocked), so this throw is not a satellite guard site.
        throw new AIException(
          'doc_fetch_blocked',
          'the document URL was blocked by the SSRF guard',
          {
            cause: error,
          }
        )
      }
      throw error
    }
    if (!response.ok) {
      throw new AIException(
        'doc_fetch_blocked',
        `the document fetch returned HTTP ${response.status}`
      )
    }
    const maxBytes = this.deps.config?.ingestionMaxBytes ?? DEFAULT_INGESTION_MAX_BYTES
    return this.#drainBounded(response, maxBytes)
  }

  /**
   * Drain a streamed response body, aborting the transfer (cancelling the reader
   * destroys the pinned socket) the moment the accumulated bytes exceed
   * `maxBytes`. Bounding DURING transfer, not after a full buffer, is what makes
   * `ingestionMaxBytes` a real memory bound rather than a post-mortem rejection.
   */
  async #drainBounded(response: Response, maxBytes: number): Promise<string> {
    const body = response.body
    if (!body) return ''
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value?.byteLength) continue
        total += value.byteLength
        if (total > maxBytes) {
          throw new AIException(
            'invalid_request',
            `the fetched document exceeds ingestionMaxBytes (${maxBytes})`
          )
        }
        chunks.push(value)
      }
    } catch (error) {
      if (error instanceof AIException) throw error
      // A mid-transfer read failure is a failed document fetch (fatal 400), same
      // class as a non-2xx or a blocked URL; never a silent partial embed.
      throw new AIException(
        'doc_fetch_blocked',
        'the document fetch failed while reading the body',
        {
          cause: error,
        }
      )
    } finally {
      // Cancel always: on the over-cap throw it stops the transfer and frees the
      // socket; after a clean end it is a no-op on the drained stream.
      await reader.cancel().catch(() => {})
    }
    return Buffer.concat(
      chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))
    ).toString('utf8')
  }
}

/**
 * The row dedup key: SHA-256 hex over `(model, content)`. The model is first
 * hashed to a fixed 64-hex prefix, so the model/content boundary is unambiguous
 * (no separator a model name or the content could forge a collision across).
 * Folding the model in means the `UNIQUE(source, content_hash)` constraint keys
 * on the embedding that actually produced the vector, so the same content
 * re-embedded under a DIFFERENT model is a new row rather than a swallowed
 * `ON CONFLICT DO NOTHING` no-op that would leave retrieval under the new model
 * empty. `dim` is deterministic per deploy (the migrated `vector(N)`), so it
 * needs no separate term.
 */
function dedupHash(model: string, content: string): string {
  const modelKey = createHash('sha256').update(model).digest('hex')
  return createHash('sha256').update(modelKey).update(content).digest('hex')
}

/** Map a reserve failure to a code, mirroring the streaming spine: quota exceeded -> 402, else fail-closed 503. */
function classifyReserveError(error: unknown): AIErrorCode {
  const code = (error as { code?: string } | null)?.code
  if (code === 'E_TENANT_QUOTA_EXCEEDED') return 'over_budget'
  return 'rate_limit_unavailable'
}
