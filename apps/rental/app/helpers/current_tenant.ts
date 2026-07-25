import type { HttpContext } from '@adonisjs/core/http'
import type Tenant from '#app/models/backoffice/tenant'

/**
 * Narrow `request.tenant()` to this app's concrete Tenant model, in exactly one
 * place. The repository bound to TENANT_REPOSITORY only ever returns this model,
 * so the narrowing is sound. Call it from tenant-guarded routes only:
 * `request.tenant()` itself throws when no tenant is resolved, so an unresolved
 * tenant fails fast rather than surfacing later as an undefined-method crash.
 */
export async function currentTenant(request: HttpContext['request']): Promise<Tenant> {
  return (await request.tenant()) as Tenant
}
