import TenantBranding from '../models/satellites/tenant_branding.js'
import { getCache } from '../utils/cache.js'

export interface BrandingData {
  fromName?: string | null
  fromEmail?: string | null
  logoUrl?: string | null
  primaryColor?: string | null
  supportUrl?: string | null
  emailFooter?: Record<string, unknown> | null
}

export default class BrandingService {
  private cacheKey(tenantId: string) {
    return `branding:${tenantId}`
  }

  async getForTenant(tenantId: string): Promise<TenantBranding | null> {
    const data = await getCache().namespace('branding').getOrSet({
      key: this.cacheKey(tenantId),
      ttl: '300s',
      factory: () => TenantBranding.query().where('tenant_id', tenantId).first(),
    })
    if (!data) return null
    return data instanceof TenantBranding ? data : new TenantBranding().merge(data as object)
  }

  async upsert(tenantId: string, data: BrandingData): Promise<TenantBranding> {
    const branding = await TenantBranding.updateOrCreate({ tenantId }, data)
    await getCache().namespace('branding').delete({ key: this.cacheKey(tenantId) })
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
