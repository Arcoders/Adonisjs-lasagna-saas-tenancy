import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import { resolveTenantRepository } from '@adonisjs-lasagna/saas-tenancy/services'

// `validateExternalHttpsUrl` lives in core (both admin and SsoService need it).
// Re-exported here so the admin controllers keep importing it from
// `./helpers.js` unchanged.
export { validateExternalHttpsUrl } from '@adonisjs-lasagna/saas-tenancy'

// The pure, container-free helpers live in `./pure.js` (no core barrel import)
// so they can be unit tested without booting an Ignitor. Re-exported here so the
// controllers keep importing them from `./helpers.js` unchanged.
export { clamp, isNonEmptyString } from './pure.js'

/**
 * Resolve `params.id` to a tenant or short-circuit with a 404. Returns the
 * tenant on success and `null` on failure (the response has already been
 * sent — the caller must `return`).
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
