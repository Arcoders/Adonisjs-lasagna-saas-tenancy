import AIException from '../exceptions/ai_exception.js'
import type { AIErrorCode } from '../exceptions/ai_exception.js'
import { AI_TOKENS_QUOTA, DEFAULT_MAX_EMBEDDING_TOKENS_PER_CHUNK } from '../constants.js'
import type VectorStoreService from './vector_store_service.js'
import type { VectorMatch } from './vector_store_service.js'
import type { AIEmbeddingProviderContract } from '../types/ai_embedding_contract.js'
import type { AIEmbeddingConfig, RetrievalScope } from '../define_config.js'
import type { QuotaReservation } from '@adonisjs-lasagna/saas-tenancy/services'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * The narrow QuotaService surface a query embed needs (SEAM-3): reserve/settle/
 * release. Unlike ingestion it needs no `getLimit` — a read writes no rows, so
 * it never touches the `embeddingCount` cap.
 */
export interface RetrievalQuota {
  reserve(tenant: TenantModelContract, quota: string, worstCase: number): Promise<QuotaReservation>
  settle(reservation: QuotaReservation, cumulativeUsed: number): Promise<void>
  release(reservation: QuotaReservation): Promise<number>
}

/** A validated retrieval request. Authorization (the scope) and body bounds are the controller's job. */
export interface RetrievalRequest {
  /** The natural-language query to embed and search for. */
  readonly query: string
  /** Per-request embedding model override (validated against the provider allow-list). */
  readonly model?: string
  /** How many nearest matches to return (already clamped to `maxLimit` by the caller). */
  readonly limit: number
  /** The per-user document ACL the retrievalFilter hook resolved (G2). */
  readonly scope: RetrievalScope
}

export interface RetrievalResult {
  readonly matches: VectorMatch[]
  /** The effective embedding model the provider reported (what the search filtered on). */
  readonly model: string
  /** Provider-reported tokens settled for the query embed. */
  readonly tokens: number
}

export interface RetrievalServiceDeps {
  store: VectorStoreService
  provider: AIEmbeddingProviderContract
  quota: RetrievalQuota
  /** Integer metric sink (MetricsService.emitMetric). */
  emitMetric: (tenantId: string, name: string, value: number) => void
  config: AIEmbeddingConfig | undefined
}

/**
 * The retrieval (RAG read) orchestrator (WS-AI-5). It runs the same fail-closed
 * cost order as ingestion, minus the write: reserve the worst-case `aiTokens`
 * for a single query embed (a retrieval read still costs an embedding call, so
 * it is metered like a completion, G5), embed the query, search the tenant's
 * vector store under the resolved document ACL scope, then settle the actual
 * tokens and always release the hold. The query is embedded with the SAME
 * provider the corpus was, and the search filters on the provider-reported
 * effective model, so a model naming drift can never silently return zero rows.
 * Authorization (the scope), request-shape validation and rate limiting are the
 * controller's responsibility; this service trusts a validated request.
 *
 * Stateful only through its injected seams, so it is a container singleton
 * (never `new`-ed per request).
 */
export default class RetrievalService {
  constructor(private readonly deps: RetrievalServiceDeps) {}

  /** The provider key fingerprint (or its name) for the per-key rate-limit bucket (threat #4). */
  get providerFingerprint(): string {
    return this.deps.provider.keyFingerprint ?? this.deps.provider.name
  }

  async retrieve(
    tenant: TenantModelContract,
    request: RetrievalRequest,
    signal: AbortSignal
  ): Promise<RetrievalResult> {
    // A sources allow-list authorizing zero documents can never match a row, so
    // return without spending an embed (a scope that sees nothing costs nothing).
    if (request.scope.kind === 'sources' && request.scope.sources.length === 0) {
      return { matches: [], model: request.model ?? '', tokens: 0 }
    }

    const worstCase = this.deps.config?.maxEmbeddingTokens ?? DEFAULT_MAX_EMBEDDING_TOKENS_PER_CHUNK

    let reservation: QuotaReservation
    try {
      reservation = await this.deps.quota.reserve(tenant, AI_TOKENS_QUOTA, worstCase)
    } catch (error) {
      // Fail-closed by construction: a quota-backend outage is a 503, not a free read.
      throw new AIException(
        classifyReserveError(error),
        'the ai cost governor rejected the reservation',
        { cause: error }
      )
    }

    try {
      const embedded = await this.deps.provider.embed(
        { input: [request.query], model: request.model },
        signal
      )
      const vector = embedded.embeddings[0] ?? []
      const matches = await this.deps.store.search(
        tenant,
        { model: embedded.model, vector },
        { limit: request.limit, filter: request.scope }
      )
      await this.deps.quota.settle(reservation, embedded.tokens)
      this.deps.emitMetric(tenant.id, 'ai_retrieval_tokens_total', embedded.tokens)
      this.deps.emitMetric(tenant.id, 'ai_retrieval_matches', matches.length)
      return { matches, model: embedded.model, tokens: embedded.tokens }
    } catch (error) {
      this.deps.emitMetric(tenant.id, 'ai_retrieval_errors', 1)
      throw error
    } finally {
      // Always return the unused hold, whatever happened after the reserve.
      await this.deps.quota.release(reservation).catch(() => {})
    }
  }
}

/** Map a reserve failure to a code, mirroring the ingestion path: quota exceeded -> 402, else fail-closed 503. */
function classifyReserveError(error: unknown): AIErrorCode {
  const code = (error as { code?: string } | null)?.code
  if (code === 'E_TENANT_QUOTA_EXCEEDED') return 'over_budget'
  return 'rate_limit_unavailable'
}
