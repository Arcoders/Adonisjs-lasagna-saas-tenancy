import type { TenantAccessAuthorizer } from '@adonisjs-lasagna/saas-tenancy/types'
import { isAuthorizedStaff } from '#app/security/session_realm'

/**
 * Anonymous requests are refused by default; only these public entry points on
 * a tenant host may be reached without a session or token. Everything else
 * requires proof of membership in the resolved company.
 */
const PUBLIC_TENANT_PATHS: RegExp[] = [
  /^\/login$/, // tenant staff login page (Inertia GET) + POST
  /^\/auth\/login$/, // programmatic tenant login (API/e2e)
  /^\/sso\//, // OIDC login start + callback
  /^\/branding\/public/, // public branding used to theme the login page
]

/**
 * The membership gate (`config.authorizeTenantAccess`), run by
 * TenantGuardMiddleware after the lifecycle checks. Returning `false` (or
 * throwing) makes the guard answer 403 before any controller runs.
 *
 * Deny-by-default, unlike the reference demo which lets anonymous traffic
 * through for curl exploration. Karimoto is a real app: the caller must prove
 * they belong to the resolved company.
 *
 * The gate is prefix-agnostic on purpose — no branch inspects the `bko_` /
 * `tnt_` token prefixes. An operator token on a tenant route fails here for the
 * same structural reason a company-B token does: it is not a valid token of the
 * RESOLVED company (its `auth_access_tokens` row lives in another schema).
 */
export function createMembershipAuthorizer(): TenantAccessAuthorizer {
  return async (ctx, tenant) => {
    // Programmatic realm: any bearer on a tenant route must be a valid token of
    // the RESOLVED company. The tenant guard looks the token up inside that
    // company's own schema, so operator tokens, garbage, and tokens minted by
    // another company all fail. check() returns false on unauthorized and
    // re-throws infra errors, which the authorizer registry converts to deny,
    // so every path stays fail-closed. API/e2e callers address the company by
    // the `x-tenant-id` header, which the adapter's sync resolver reads directly.
    if (ctx.request.header('authorization')) {
      return ctx.auth.use('tenant').check()
    }

    // Browser realm: a valid `web-tenant` session that was issued FOR this
    // company proves membership. isAuthorizedStaff() pins the session to its
    // origin company and runs the staff lookup in the tenant's schema; a session
    // stolen from another company is refused even if that company happens to
    // have a user with the same per-schema id. (In a browser it never arrives at
    // all — the session cookie is host-only to `<slug>.localhost`.)
    if (await isAuthorizedStaff(ctx, tenant)) {
      return true
    }

    // Anonymous: allowed only at the public entry points, denied everywhere else.
    const path = ctx.request.url()
    return PUBLIC_TENANT_PATHS.some((re) => re.test(path))
  }
}
