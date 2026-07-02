import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import { TenantAccessForbiddenException } from '@adonisjs-lasagna/saas-tenancy/exceptions'
import type { AiConfig, AIEmbeddingConfig, RetrievalScope } from '../define_config.js'
import AIException from '../exceptions/ai_exception.js'
import { emitAiGuardEvent } from '../isthmus/ai_guard_audit.js'

/**
 * The per-request AI membership gate (G4), the runtime backstop behind the
 * fail-closed route mount. Mirrors the kernel's `authorizeTenantAccess`
 * contract with one deliberate hardening: a hook that THROWS is a denial (403
 * with the original error as cause), never a 500. An erroring authorization
 * backend must fail closed; surfacing it as an internal error would let a
 * membership-service outage read as a bug instead of a deny.
 *
 * Decision table, in order:
 * - hook present, returns truthy: pass.
 * - hook present, returns falsy or throws: emit `guard.ai_access`, throw 403.
 * - hook absent, `acknowledgeNoMembershipGate === true`: pass (the host
 *   acknowledged that its own middleware chain is the only access control;
 *   the mount warning and the doctor check keep the posture visible).
 * - hook absent otherwise: emit and throw 403. `multitenancyAiRoutes` refuses
 *   this configuration at mount time, so reaching it here means the route was
 *   mounted around the gate; the backstop still denies.
 */
/**
 * The tenant a mounted AI route runs for, via the kernel's `request.tenant()`
 * macro (memoized, lifecycle-checked by TenantGuard earlier in the chain). A
 * request that reaches the gateway with NO resolvable tenant means the route
 * was mounted without TenantGuard; that is a mis-mount, and the backstop is a
 * fail-closed 403 with a `guard.ai_access` emission, never a stream.
 */
export async function resolveRequestTenant(ctx: HttpContext): Promise<TenantModelContract> {
  const request = ctx.request as HttpContext['request'] & {
    tenant?: () => Promise<TenantModelContract | null>
  }
  const tenant = typeof request.tenant === 'function' ? await request.tenant() : null
  if (!tenant) {
    emitAiGuardEvent('guard.ai_access', { metadata: { reason: 'no_tenant' } })
    throw new TenantAccessForbiddenException()
  }
  return tenant
}

export async function authorizeAiAccess(
  ctx: HttpContext,
  tenant: TenantModelContract,
  ai: AiConfig | undefined
): Promise<void> {
  const hook = ai?.authorizeAIAccess

  if (!hook) {
    if (ai?.acknowledgeNoMembershipGate === true) return
    emitAiGuardEvent('guard.ai_access', {
      tenantId: tenant.id,
      metadata: { reason: 'no_gate' },
    })
    throw new TenantAccessForbiddenException()
  }

  let allowed: unknown
  try {
    allowed = await hook(ctx, tenant)
  } catch (error) {
    emitAiGuardEvent('guard.ai_access', {
      tenantId: tenant.id,
      metadata: { reason: 'hook_error' },
    })
    throw new TenantAccessForbiddenException(TenantAccessForbiddenException.message, {
      cause: error,
    })
  }

  if (!allowed) {
    emitAiGuardEvent('guard.ai_access', {
      tenantId: tenant.id,
      metadata: { reason: 'denied' },
    })
    throw new TenantAccessForbiddenException()
  }
}

/**
 * The ingestion WRITE gate (WS-AI-3), distinct from {@link authorizeAiAccess}
 * ("may this caller use AI at all"): it decides "may this caller WRITE to the
 * tenant's vector index". Opt-in via `config.ai.embedding.authorizeIngestion`;
 * when the hook is absent the write is allowed (the access gate already ran).
 * When present and it returns falsy or throws, the embed is refused with a 403
 * `ingestion_denied` and a `guard.ai_ingestion_denied` trip, before any
 * reservation or provider call.
 */
export async function authorizeIngestion(
  ctx: HttpContext,
  tenant: TenantModelContract,
  embedding: AIEmbeddingConfig | undefined
): Promise<void> {
  const hook = embedding?.authorizeIngestion
  if (!hook) return

  let allowed: unknown
  try {
    allowed = await hook(ctx, tenant)
  } catch (error) {
    emitAiGuardEvent('guard.ai_ingestion_denied', {
      tenantId: tenant.id,
      metadata: { reason: 'hook_error' },
    })
    throw new AIException(
      'ingestion_denied',
      'Refusing the ingest: not authorized to write embeddings',
      {
        cause: error,
      }
    )
  }

  if (!allowed) {
    emitAiGuardEvent('guard.ai_ingestion_denied', {
      tenantId: tenant.id,
      metadata: { reason: 'denied' },
    })
    throw new AIException(
      'ingestion_denied',
      'Refusing the ingest: not authorized to write embeddings'
    )
  }
}

/**
 * Resolve the retrieval scope (WS-AI-5, G2), the per-user document ACL applied
 * to a similarity search. Mirrors {@link authorizeIngestion} but returns a
 * {@link RetrievalScope} rather than void, because a document ACL answers "WHICH
 * documents may this caller see", not a boolean "may they retrieve at all".
 *
 * Opt-in via `config.ai.retrieval.retrievalFilter`. Fail-closed (G2), mirroring
 * the G4 mount gate: when NO hook is wired the retrieval is refused with a 403
 * `retrieval_denied` and a `guard.ai_retrieval_denied` trip, UNLESS the host sets
 * `config.ai.acknowledgeUnscopedRetrieval`, which opts into tenant-wide retrieval
 * (`{ kind: 'all' }`; tenant isolation still holds, and the missing per-user ACL
 * is a documented honest limit surfaced by the `ai_retrieval_gate` doctor check).
 * When a hook IS wired and it throws or returns a shape that is not a valid scope,
 * the retrieval is likewise refused, before any query embed or search: never a
 * silent fallback to the whole corpus.
 */
export async function resolveRetrievalScope(
  ctx: HttpContext,
  tenant: TenantModelContract,
  ai: AiConfig | undefined
): Promise<RetrievalScope> {
  const hook = ai?.retrieval?.retrievalFilter
  if (!hook) {
    if (ai?.acknowledgeUnscopedRetrieval === true) return { kind: 'all' }
    emitAiGuardEvent('guard.ai_retrieval_denied', {
      tenantId: tenant.id,
      metadata: { reason: 'unscoped_unacknowledged' },
    })
    throw new AIException(
      'retrieval_denied',
      'Refusing the retrieval: no per-user document ACL (config.ai.retrieval.retrievalFilter) ' +
        'is wired and config.ai.acknowledgeUnscopedRetrieval is not set'
    )
  }

  let scope: unknown
  try {
    scope = await hook(ctx, tenant)
  } catch (error) {
    emitAiGuardEvent('guard.ai_retrieval_denied', {
      tenantId: tenant.id,
      metadata: { reason: 'hook_error' },
    })
    throw new AIException(
      'retrieval_denied',
      'Refusing the retrieval: the document ACL hook failed',
      { cause: error }
    )
  }

  if (!isRetrievalScope(scope)) {
    emitAiGuardEvent('guard.ai_retrieval_denied', {
      tenantId: tenant.id,
      metadata: { reason: 'invalid_scope' },
    })
    throw new AIException(
      'retrieval_denied',
      'Refusing the retrieval: the document ACL hook returned an invalid scope'
    )
  }
  return scope
}

/** Whether a value is a well-formed {@link RetrievalScope} (a wired hook must return one). */
function isRetrievalScope(value: unknown): value is RetrievalScope {
  if (typeof value !== 'object' || value === null) return false
  const scope = value as { kind?: unknown; sources?: unknown; match?: unknown }
  if (scope.kind === 'all') return true
  if (scope.kind === 'sources') {
    return Array.isArray(scope.sources) && scope.sources.every((s) => typeof s === 'string')
  }
  if (scope.kind === 'metadata') {
    return typeof scope.match === 'object' && scope.match !== null && !Array.isArray(scope.match)
  }
  return false
}
