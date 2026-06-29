import TenantBranding from '../models/satellites/tenant_branding.js'
import { getCache } from '../utils/cache.js'
import { tenancy } from '../tenancy.js'

/**
 * Shape of the customizable branding fields a tenant can configure, used as the
 * input payload for upserting a tenant's branding record. Every property is
 * optional and nullable, covering the sender name and email, a logo URL, a
 * primary brand color, a support URL, and a structured email footer object.
 */
export interface BrandingData {
  fromName?: string | null
  fromEmail?: string | null
  logoUrl?: string | null
  primaryColor?: string | null
  supportUrl?: string | null
  emailFooter?: Record<string, unknown> | null
}

/**
 * Manages per-tenant branding stored in the `tenant_branding` satellite table, covering
 * from-name, from-email, logo URL, primary color, support URL, and an email footer. Reads
 * are served through a cached `getForTenant(tenantId)` (5 minute TTL in the `branding`
 * namespace) and a scope-aware `getCurrent()` that resolves the active tenant from the
 * ambient `tenancy` context. Writes go through `upsert()`, which updates or creates the row
 * and invalidates the cache, while `renderEmailContext()` flattens a branding record into
 * mail-template values with platform defaults when fields are missing.
 *
 * @see getForTenant
 * @see getCurrent
 * @see upsert
 */
export default class BrandingService {
  private cacheKey(tenantId: string) {
    return `branding:${tenantId}`
  }

  async getForTenant(tenantId: string): Promise<TenantBranding | null> {
    const data = await getCache()
      .namespace('branding')
      .getOrSet({
        key: this.cacheKey(tenantId),
        ttl: '300s',
        factory: () => TenantBranding.query().where('tenant_id', tenantId).first(),
      })
    if (!data) return null
    return data instanceof TenantBranding ? data : new TenantBranding().merge(data as object)
  }

  /**
   * Branding for the tenant active in the current scope, resolving the id from
   * the ambient `tenancy` context instead of taking it as an argument. Works
   * inside an HTTP request (the tenant guard binds the context) or a
   * `tenancy.run(tenant, fn)` scope (jobs, commands, tests). Mirrors the
   * `tenantMailer()` idiom.
   *
   * Throws when called outside a tenant scope — there is no id to resolve.
   */
  async getCurrent(): Promise<TenantBranding | null> {
    const id = tenancy.currentId()
    if (!id) {
      throw new Error(
        'BrandingService.getCurrent() called outside a tenant scope. Use it inside ' +
          'an HTTP request (tenant guard active) or a tenancy.run(tenant, fn) scope.'
      )
    }
    return this.getForTenant(id)
  }

  async upsert(tenantId: string, data: BrandingData): Promise<TenantBranding> {
    const branding = await TenantBranding.updateOrCreate({ tenantId }, data)
    await getCache()
      .namespace('branding')
      .delete({ key: this.cacheKey(tenantId) })
    return branding
  }

  renderEmailContext(branding: TenantBranding | null) {
    return {
      fromName: branding?.fromName ?? 'Platform',
      fromEmail: branding?.fromEmail ?? 'noreply@platform.com',
      logoUrl: branding?.logoUrl ?? null,
      primaryColor: branding?.primaryColor ?? '#3b82f6',
      supportUrl: branding?.supportUrl ?? null,
      footer: branding?.emailFooter ?? {},
    }
  }
}
