import type { HttpContext } from '@adonisjs/core/http'
import type RetrievalService from '../services/retrieval_service.js'
import type TenantLivenessWatcher from '../services/tenant_liveness_watcher.js'
import type AiRateLimiter from '../services/ai_rate_limiter.js'
import { DISABLED_AI_RATE_LIMITER } from '../services/ai_rate_limiter.js'
import { authorizeAiAccess, resolveRequestTenant, resolveRetrievalScope } from './access_gate.js'
import {
  hashAuditPrincipal,
  noopRetrievalAuditSink,
  type AiRetrievalAuditSink,
} from './audit_seam.js'
import AIException from '../exceptions/ai_exception.js'
import type { AiConfig, AIRetrievalConfig } from '../define_config.js'
import { DEFAULT_MAX_QUERY_CHARS, DEFAULT_RETRIEVAL_LIMIT, MAX_RETRIEVAL_LIMIT } from '../constants.js'

/** The retrieve request body. Everything else is ignored. */
interface RetrieveBody {
  query: string
  model?: string
  limit: number
}

export interface AiRetrieveControllerDeps {
  retrieval: RetrievalService
  liveness: TenantLivenessWatcher
  config: AiConfig | undefined
  /** The per-key request rate limiter (threat #4). Default: a disabled limiter. */
  rateLimiter?: AiRateLimiter
  /** The WS-AI-7 attribution seam. Default: the no-op sink. */
  audit?: AiRetrievalAuditSink
}

/**
 * The `/ai/retrieve` choke point (WS-AI-5), mirroring the embed controller's
 * sequence: authorize FIRST (a denied caller spends nothing), then resolve the
 * per-user document ACL (G2) BEFORE any cost, then validate the body, rate-limit
 * the provider key, and hand a scoped request to the retrieval service (which
 * owns reserve/embed/search/settle). Returns JSON matches, not SSE.
 * Instantiated per request (stateless).
 */
export default class AiRetrieveController {
  constructor(private readonly deps: AiRetrieveControllerDeps) {}

  async retrieve(ctx: HttpContext): Promise<void> {
    const ai = this.deps.config

    // 1. Tenant + membership gate + the per-user document ACL (403s, before any cost).
    const tenant = await resolveRequestTenant(ctx)
    await authorizeAiAccess(ctx, tenant, ai)
    const scope = await resolveRetrievalScope(ctx, tenant, ai?.retrieval)

    // 2. Request validation (400s, still before any cost).
    const body = parseRetrieveBody(ctx.request.body(), ai?.retrieval)
    const principalHash = hashAuditPrincipal(resolvePrincipal(ctx, ai))
    const auditBase = { tenantId: tenant.id, actorHash: principalHash }

    const liveness = this.deps.liveness.acquire(tenant.id)
    try {
      // 3. Per-key request rate limit (threat #4), before any reservation or byte.
      await (this.deps.rateLimiter ?? DISABLED_AI_RATE_LIMITER).check({
        op: 'retrieve',
        tenantId: tenant.id,
        fingerprint: this.deps.retrieval.providerFingerprint,
      })

      // 4. The fail-closed reserve/embed/search/settle machine.
      const result = await this.deps.retrieval.retrieve(
        tenant,
        { query: body.query, model: body.model, limit: body.limit, scope },
        liveness.signal
      )

      await this.#audit().append({
        ...auditBase,
        model: result.model,
        matchCount: result.matches.length,
        tokens: result.tokens,
        outcome: 'completed',
        reason: null,
        occurredAt: new Date().toISOString(),
      })
      ctx.response.status(200).send({ matches: result.matches })
    } catch (error) {
      const code = error instanceof AIException ? error.aiCode : null
      await this.#audit().append({
        ...auditBase,
        model: body.model ?? null,
        matchCount: 0,
        tokens: 0,
        outcome: 'failed_preflight',
        reason: code ?? 'error',
        occurredAt: new Date().toISOString(),
      })
      if (error instanceof AIException) {
        ctx.response.status(error.httpStatus).send({ error: error.aiCode })
        return
      }
      throw error
    } finally {
      liveness.dispose()
    }
  }

  #audit(): AiRetrievalAuditSink {
    return this.deps.audit ?? noopRetrievalAuditSink
  }
}

function invalid(message: string): never {
  throw new AIException('invalid_request', message)
}

/**
 * Validate the retrieve body shape and bounds before any reservation or provider
 * call. `query` is a required non-empty string bounded by `maxQueryChars`;
 * `limit` is an optional positive integer clamped to `maxLimit` (defaulting to
 * `defaultLimit`); `model` is an optional per-request override. Error messages
 * name the field, never echo the query (G3).
 */
function parseRetrieveBody(raw: unknown, retrieval: AIRetrievalConfig | undefined): RetrieveBody {
  if (typeof raw !== 'object' || raw === null) {
    invalid('the retrieve body must be a JSON object')
  }
  const body = raw as Record<string, unknown>

  if (typeof body.query !== 'string' || body.query.length === 0) {
    invalid('query must be a non-empty string')
  }
  const maxQueryChars = retrieval?.maxQueryChars ?? DEFAULT_MAX_QUERY_CHARS
  if (body.query.length > maxQueryChars) {
    invalid(`query must be at most ${maxQueryChars} characters`)
  }

  if (body.model !== undefined && (typeof body.model !== 'string' || body.model.length === 0)) {
    invalid('model, when set, must be a non-empty string')
  }

  const maxLimit = retrieval?.maxLimit ?? MAX_RETRIEVAL_LIMIT
  let limit = retrieval?.defaultLimit ?? DEFAULT_RETRIEVAL_LIMIT
  if (body.limit !== undefined) {
    if (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit <= 0) {
      invalid('limit, when set, must be a positive integer')
    }
    limit = Math.min(body.limit, maxLimit)
  }

  return {
    query: body.query,
    model: body.model as string | undefined,
    limit,
  }
}

/** The principal for attribution, or null when none is resolvable. */
function resolvePrincipal(ctx: HttpContext, ai: AiConfig | undefined): string | null {
  const raw = ai?.resolvePrincipal
    ? ai.resolvePrincipal(ctx)
    : (ctx as { auth?: { user?: { id?: unknown } } }).auth?.user?.id
  if (raw === null || raw === undefined) return null
  const principal = String(raw)
  return principal.length > 0 ? principal : null
}
