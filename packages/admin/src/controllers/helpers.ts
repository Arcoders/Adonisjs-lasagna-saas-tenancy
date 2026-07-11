import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import { resolveTenantRepository, AuditLogService } from '@adonisjs-lasagna/saas-tenancy/services'
import { getAdminActorResolver } from '../admin_actor.js'

// `validateExternalHttpsUrl` lives in core (both admin and SsoService need it).
// It sits on `/internal` rather than the root barrel: a host app never validates
// an issuer URL by hand. Re-exported here so the admin controllers keep importing
// it from `./helpers.js` unchanged.
export { validateExternalHttpsUrl } from '@adonisjs-lasagna/saas-tenancy/internal'

// The pure, container-free helpers live in `./pure.js` (no core barrel import)
// so they can be unit tested without booting an Ignitor. Re-exported here so the
// controllers keep importing them from `./helpers.js` unchanged.
export { clamp, isNonEmptyString } from './pure.js'

/**
 * Resolve `params.id` to a tenant or short-circuit with a 404. Returns the
 * tenant on success and `null` on failure (the response has already been
 * sent, so the caller must `return`).
 */
export async function loadTenantOr404(ctx: HttpContext): Promise<TenantModelContract | null> {
  const repo = await resolveTenantRepository()
  const tenant = await repo.findById(ctx.params.id, true)
  if (!tenant) {
    ctx.response.notFound({ error: 'tenant_not_found' })
    return null
  }
  return tenant
}

/**
 * Record an attributed audit row for a mutating admin action. Call it AFTER the
 * mutation succeeds, before the controller returns. The acting admin id comes
 * from the wired `resolveAdminActor` hook, never from the request body.
 *
 * This is best-effort by design and must NEVER fail the operation it records:
 * the whole call is wrapped so a missing resolver, a container miss, or a
 * throwing audit write all degrade to a swallowed no-op (same posture as
 * `ImpersonationService`'s audit). The metadata must carry ids and flags only,
 * never secrets. `audit_coverage.spec.ts` enforces that statically.
 *
 * `actorType` is always `'admin'` on the REST path. A null actor (no resolver,
 * or a resolver that returned null) still writes a row with `actorId: null`: a
 * config mutation, unlike minting an impersonation credential, should leave
 * evidence even when attribution is unavailable.
 */
export async function auditAdminAction(
  ctx: HttpContext,
  action: string,
  tenantId: string | null,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    const resolver = getAdminActorResolver()
    const actorId = resolver ? await resolver(ctx) : null
    // `ip()` is guarded: some contexts (and lightweight test clients) do not
    // expose a callable `request.ip`, and a throw here must not reach the caller.
    const ipAddress = typeof ctx.request.ip === 'function' ? ctx.request.ip() : null
    const audit = await app.container.make(AuditLogService)
    await audit.log({
      tenantId,
      actorType: 'admin',
      actorId: actorId ?? null,
      action,
      metadata,
      ipAddress,
    })
  } catch (error) {
    // Best-effort: auditing must never fail the audited operation. But a
    // swallowed write means a privileged action left no evidence, so log it
    // loudly instead of letting it disappear (the silent-loss bug that motivated
    // widening `actor_id` to text). Never throw out of here.
    try {
      const logger = await app.container.make('logger').catch(() => undefined)
      logger?.error(
        { action, tenant_id: tenantId, err: (error as Error)?.message },
        'admin.audit.write_failed: a privileged action was NOT recorded'
      )
    } catch {
      /* logging must never throw out of the audit helper */
    }
  }
}
