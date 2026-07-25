import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Session key holding the id of the company a `web-tenant` session was issued
 * for. Set once at login; read on every authorization.
 */
export const WEB_TENANT_COMPANY_KEY = 'web_tenant_company'

/**
 * True iff the request carries a valid `web-tenant` session that was issued for
 * THIS exact company.
 *
 * The company binding is a real isolation control, not a nicety. Staff user ids
 * are per-schema auto-increment integers, so two companies routinely have a
 * user with the same id (e.g. each owner is `id = 1` in its own schema). A
 * session that only carried the bare user id would therefore authenticate as
 * company B's `id = 1` if company A's cookie were replayed against B's host.
 * Host-only cookies stop that in a browser, but a stolen-cookie replay would
 * slip through — so we also pin the session to the globally-unique company id
 * captured at login. The cookie is encrypted with APP_KEY, so the pin cannot be
 * forged.
 *
 * The user lookup runs inside `tenancy.run(tenant, …)` so the session guard's
 * `TenantUser` query routes to this company's schema even on host-addressed
 * browser requests, which carry no `x-tenant-id` header for the sync resolver.
 */
export async function isAuthorizedStaff(
  ctx: HttpContext,
  tenant: TenantModelContract
): Promise<boolean> {
  if (ctx.session?.get(WEB_TENANT_COMPANY_KEY) !== tenant.id) return false
  const { tenancy } = await import('@adonisjs-lasagna/saas-tenancy')
  return tenancy.run(tenant, () => ctx.auth.use('web-tenant').check())
}
