import type { HttpContext } from '@adonisjs/core/http'
import type Tenant from '#app/models/backoffice/tenant'

/**
 * Narrow `request.tenant()` to this app's concrete Tenant model, in exactly
 * one place. The v2 contract deliberately dropped `getConnection` (routing
 * lives on the isolation driver now), but the demo's raw-SQL endpoints still
 * use the model's own getConnection()/getReadConnection(). The repository
 * bound to TENANT_REPOSITORY (app/providers/app_provider.ts) only ever
 * returns this model, so the narrowing is sound. Call it from tenant-guarded
 * routes only — an unresolved tenant throws instead of surfacing later as an
 * undefined-method crash.
 */
export async function currentTenant(request: HttpContext['request']): Promise<Tenant> {
  const tenant = await request.tenant()
  if (!tenant) {
    throw new Error('currentTenant() needs a tenant-guarded route — request.tenant() was null')
  }
  return tenant as Tenant
}
