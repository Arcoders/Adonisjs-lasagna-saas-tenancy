import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import { TenantAccessForbiddenException } from '@adonisjs-lasagna/saas-tenancy/exceptions'
import type { AiConfig } from '../define_config.js'
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
