import type { TenantAccessAuthorizer } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * The demo's membership gate (`config.authorizeTenantAccess`). Header-based
 * resolution is trust-the-input: whoever sends `x-tenant-id` picks the tenant,
 * so this seam is what proves the caller actually belongs to it. Deny (or
 * throw) means TenantGuardMiddleware answers 403 before any controller runs.
 *
 * The gate is prefix-agnostic on purpose: no branch inspects the `bko_` /
 * `tnt_` token prefixes. An operator token on a tenant route fails here for
 * the same structural reason a tenant-B token does: it is not a valid token
 * of the resolved tenant.
 */
export function createMembershipAuthorizer(): TenantAccessAuthorizer {
  return async (ctx, tenant) => {
    // A stand-in for an authenticated principal's tenant, kept for the
    // membership_gate e2e: when present, the caller's tenant must match the
    // resolved tenant exactly.
    const principalTenant = ctx.request.header('x-test-principal-tenant')
    if (principalTenant) {
      return principalTenant === tenant.id
    }

    // Any bearer on a tenant route must be a valid token of the RESOLVED
    // tenant. The tenant guard looks the token up inside that tenant's own
    // schema, so operator tokens, garbage, and tokens minted by another
    // tenant all fail. check() returns false on unauthorized and re-throws
    // infra errors, which the authorizer registry converts to deny, so every
    // path stays fail-closed.
    if (ctx.request.header('authorization')) {
      return ctx.auth.use('tenant').check()
    }

    // The demo stays open for anonymous exploration (curl without a token).
    // A real app denies here. There is no impersonation branch because it
    // would be dead code in this demo: ImpersonationMiddleware is wired only
    // on the unguarded /demo/impersonation-check, so `ctx.impersonation` is
    // never set before this gate runs. An app that denies by default must
    // decide how impersonated requests satisfy the gate; the authentication
    // guide covers that interplay.
    return true
  }
}
