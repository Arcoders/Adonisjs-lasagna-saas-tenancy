import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import { TENANT_REPOSITORY } from '@adonisjs-lasagna/saas-tenancy/types'
import type {
  TenantRepositoryContract,
  TenantModelContract,
} from '@adonisjs-lasagna/saas-tenancy/types'

// `validateExternalHttpsUrl` lives in core (both admin and SsoService need it).
// Re-exported here so the admin controllers keep importing it from
// `./helpers.js` unchanged.
export { validateExternalHttpsUrl } from '@adonisjs-lasagna/saas-tenancy'

/**
 * Resolve `params.id` to a tenant or short-circuit with a 404. Returns the
 * tenant on success and `null` on failure (the response has already been
 * sent — the caller must `return`).
 */
export async function loadTenantOr404(ctx: HttpContext): Promise<TenantModelContract | null> {
  const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
  const tenant = await repo.findById(ctx.params.id, true)
  if (!tenant) {
    ctx.response.notFound({ error: 'tenant_not_found' })
    return null
  }
  return tenant
}

export function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}
