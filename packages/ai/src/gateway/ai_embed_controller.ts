import type { HttpContext } from '@adonisjs/core/http'
import type EmbeddingIngestionService from '../services/embedding_ingestion_service.js'
import type TenantLivenessWatcher from '../services/tenant_liveness_watcher.js'
import type AiRateLimiter from '../services/ai_rate_limiter.js'
import { DISABLED_AI_RATE_LIMITER } from '../services/ai_rate_limiter.js'
import { authorizeAiAccess, authorizeIngestion, resolveRequestTenant } from './access_gate.js'
import { enforceEmbeddingResidency } from '../services/residency_gate.js'
import {
  hashAuditPrincipal,
  noopEmbeddingAuditSink,
  type AiEmbeddingAuditSink,
} from './audit_seam.js'
import AIException from '../exceptions/ai_exception.js'
import type { AiConfig, AIEmbeddingConfig } from '../define_config.js'
import {
  AI_SOURCE_MAX_CHARS,
  DEFAULT_MAX_BATCH_CHUNKS,
  DEFAULT_MAX_CHUNK_CHARS,
  DEFAULT_MAX_METADATA_BYTES,
} from '../constants.js'

/** The embed request body. Everything else is ignored. */
interface EmbedBody {
  source: string
  input: string[]
  sourceUrl?: string | undefined
  metadata: Record<string, unknown>
  model?: string | undefined
}

export interface AiEmbedControllerDeps {
  ingestion: EmbeddingIngestionService
  liveness: TenantLivenessWatcher
  config: AiConfig | undefined
  /** The per-key request rate limiter. Default: a disabled limiter. */
  rateLimiter?: AiRateLimiter
  /** The attribution seam. Default: the no-op sink. */
  audit?: AiEmbeddingAuditSink | undefined
}

/**
 * The `/ai/embed` ingest choke point, mirroring the chat controller's
 * sequence: authorize FIRST (a denied caller reserves nothing), then the write
 * gate, then validate the body, rate-limit the provider key, and hand a
 * validated request to the ingestion service (which owns reserve/embed/store/
 * settle). Returns JSON, not SSE. Idempotency is durable at the store
 * (`UNIQUE(source, content_hash)`), so a retry re-embeds but never double-writes;
 * no `Idempotency-Key` header is required. Instantiated per request (stateless).
 */
export default class AiEmbedController {
  constructor(private readonly deps: AiEmbedControllerDeps) {}

  async embed(ctx: HttpContext): Promise<void> {
    const ai = this.deps.config

    // 1. Tenant + membership gate + the ingestion write gate + data residency
    //    (403s, before any cost). Residency refuses shipping documents
    //    to a remote embedding backend when the tenant is `local-only`, before
    //    the rate limiter, so a refused caller spends nothing.
    const tenant = await resolveRequestTenant(ctx)
    await authorizeAiAccess(ctx, tenant, ai)
    await authorizeIngestion(ctx, tenant, ai?.embedding)
    await enforceEmbeddingResidency(tenant, ai)

    // 2. Request validation (400s, still before any cost).
    const body = parseEmbedBody(ctx.request.body(), ai?.embedding)
    const principalHash = hashAuditPrincipal(resolvePrincipal(ctx, ai))

    const auditBase = {
      tenantId: tenant.id,
      actorHash: principalHash,
      sourceHash: hashAuditPrincipal(body.source),
    }

    const liveness = this.deps.liveness.acquire(tenant.id)
    try {
      // 3. Per-key request rate limit, before any reservation or byte.
      await (this.deps.rateLimiter ?? DISABLED_AI_RATE_LIMITER).check({
        op: 'embed',
        tenantId: tenant.id,
        fingerprint: this.deps.ingestion.providerFingerprint,
      })

      // 4. The fail-closed reserve/embed/store/settle machine.
      const result = await this.deps.ingestion.ingest(
        tenant,
        {
          source: body.source,
          input: body.input,
          sourceUrl: body.sourceUrl,
          metadata: body.metadata,
          model: body.model,
          actorHash: principalHash,
        },
        liveness.signal
      )

      await this.#audit().append({
        ...auditBase,
        model: result.model,
        dimension: result.dimension,
        embeddingsCount: result.count,
        tokens: result.tokens,
        outcome: 'completed',
        reason: null,
        occurredAt: new Date().toISOString(),
      })
      ctx.response.status(200).send({
        ids: result.ids,
        count: result.count,
        inserted: result.inserted,
        model: result.model,
        dimension: result.dimension,
      })
    } catch (error) {
      await this.#auditFailure(auditBase, body.model ?? null, error)
      if (error instanceof AIException) {
        ctx.response.status(error.httpStatus).send({ error: error.aiCode })
        return
      }
      throw error
    } finally {
      liveness.dispose()
    }
  }

  #audit(): AiEmbeddingAuditSink {
    return this.deps.audit ?? noopEmbeddingAuditSink
  }

  /**
   * Best-effort failure attribution. The SUCCESS audit above is strict fail-closed
   * (it runs before the 200, so a write outage becomes a 503, never a silent 200).
   * A failure has no completed action to attribute, so a failing audit here must
   * not mask the real error status; and when the audit ITSELF is what failed (the
   * success append threw `audit_write_failed`), re-auditing only fails again and
   * double-trips the guard, so it is skipped. The writer already tripped
   * `guard.ai_audit_write_failed` on the outage.
   */
  async #auditFailure(
    base: { tenantId: string; actorHash: string | null; sourceHash: string | null },
    model: string | null,
    error: unknown
  ): Promise<void> {
    const code = error instanceof AIException ? error.aiCode : null
    if (code === 'audit_write_failed') return
    try {
      await this.#audit().append({
        ...base,
        model,
        dimension: 0,
        embeddingsCount: 0,
        tokens: 0,
        outcome: 'failed_preflight',
        reason: code ?? 'error',
        occurredAt: new Date().toISOString(),
      })
    } catch {
      /* best-effort: never let a failed failure-audit mask the original error */
    }
  }
}

function invalid(message: string): never {
  throw new AIException('invalid_request', message)
}

/**
 * Validate the embed body shape and bounds before any reservation or provider
 * call. `source` is required; `input` is an array of non-empty chunks bounded by
 * `maxChunkChars` and `maxBatchChunks`; a request must carry at least one of
 * `input` or `sourceUrl`. Error messages name the field, never echo content.
 */
function parseEmbedBody(raw: unknown, embedding: AIEmbeddingConfig | undefined): EmbedBody {
  if (typeof raw !== 'object' || raw === null) {
    invalid('the embed body must be a JSON object')
  }
  const body = raw as Record<string, unknown>

  if (typeof body.source !== 'string' || body.source.length === 0) {
    invalid('source must be a non-empty string')
  }
  if (body.source.length > AI_SOURCE_MAX_CHARS) {
    invalid(`source must be at most ${AI_SOURCE_MAX_CHARS} characters`)
  }

  const maxChunkChars = embedding?.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS
  const maxBatchChunks = embedding?.maxBatchChunks ?? DEFAULT_MAX_BATCH_CHUNKS
  let input: string[] = []
  if (body.input !== undefined) {
    if (!Array.isArray(body.input)) invalid('input, when set, must be an array of strings')
    if (body.input.length > maxBatchChunks) {
      invalid(`input has more than maxBatchChunks (${maxBatchChunks}) chunks`)
    }
    input = body.input.map((chunk, index) => {
      if (typeof chunk !== 'string' || chunk.length === 0) {
        invalid(`input[${index}] must be a non-empty string`)
      }
      if (chunk.length > maxChunkChars) {
        invalid(`input[${index}] exceeds maxChunkChars (${maxChunkChars})`)
      }
      return chunk
    })
  }

  let sourceUrl: string | undefined
  if (body.sourceUrl !== undefined) {
    if (typeof body.sourceUrl !== 'string' || body.sourceUrl.length === 0) {
      invalid('sourceUrl, when set, must be a non-empty string')
    }
    sourceUrl = body.sourceUrl
  }

  if (input.length === 0 && sourceUrl === undefined) {
    invalid('an embed needs a non-empty input array or a sourceUrl')
  }

  let metadata: Record<string, unknown> = {}
  if (body.metadata !== undefined) {
    if (
      typeof body.metadata !== 'object' ||
      body.metadata === null ||
      Array.isArray(body.metadata)
    ) {
      invalid('metadata, when set, must be a JSON object')
    }
    const maxMetadataBytes = embedding?.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES
    if (Buffer.byteLength(JSON.stringify(body.metadata), 'utf8') > maxMetadataBytes) {
      invalid(`metadata exceeds maxMetadataBytes (${maxMetadataBytes})`)
    }
    metadata = body.metadata as Record<string, unknown>
  }

  if (body.model !== undefined && (typeof body.model !== 'string' || body.model.length === 0)) {
    invalid('model, when set, must be a non-empty string')
  }

  return {
    source: body.source,
    input,
    sourceUrl,
    metadata,
    model: body.model as string | undefined,
  }
}

/** The principal for provenance/attribution, or null when none is resolvable. */
function resolvePrincipal(ctx: HttpContext, ai: AiConfig | undefined): string | null {
  const raw = ai?.resolvePrincipal
    ? ai.resolvePrincipal(ctx)
    : (ctx as { auth?: { user?: { id?: unknown } } }).auth?.user?.id
  if (raw === null || raw === undefined) return null
  const principal = String(raw)
  return principal.length > 0 ? principal : null
}
