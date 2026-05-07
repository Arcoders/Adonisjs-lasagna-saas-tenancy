import TenantFeatureFlag from '../models/satellites/tenant_feature_flag.js'
import { getCache } from '../utils/cache.js'

export default class FeatureFlagService {
  private mapCacheKey(tenantId: string) {
    return `ff_map:${tenantId}`
  }

  private singleCacheKey(tenantId: string, flag: string) {
    return `ff:${tenantId}:${flag}`
  }

  async isEnabled(tenantId: string, flag: string): Promise<boolean> {
    const map = await this.#getMap(tenantId)
    return map[flag] ?? false
  }

  async #getMap(tenantId: string): Promise<Record<string, boolean>> {
    return getCache().namespace('feature_flags').getOrSet({
      key: this.mapCacheKey(tenantId),
      ttl: '60s',
      factory: async () => {
        const rows = await TenantFeatureFlag.query().where('tenant_id', tenantId)
        return Object.fromEntries(rows.map((r) => [r.flag, r.enabled]))
      },
    }) as Promise<Record<string, boolean>>
  }

  async set(
    tenantId: string,
    flag: string,
    enabled: boolean,
    config?: Record<string, unknown>
  ): Promise<TenantFeatureFlag> {
    const row = await TenantFeatureFlag.updateOrCreate(
      { tenantId, flag },
      { enabled, config: config ?? null }
    )
    const c = getCache()
    await Promise.all([
      c.namespace('feature_flags').delete({ key: this.mapCacheKey(tenantId) }),
      c.namespace('feature_flags').delete({ key: this.singleCacheKey(tenantId, flag) }),
    ])
    return row
  }

  async listForTenant(tenantId: string): Promise<TenantFeatureFlag[]> {
    return TenantFeatureFlag.query().where('tenant_id', tenantId).orderBy('flag')
  }

  async delete(tenantId: string, flag: string): Promise<void> {
    await TenantFeatureFlag.query().where('tenant_id', tenantId).where('flag', flag).delete()
    const c = getCache()
    await Promise.all([
      c.namespace('feature_flags').delete({ key: this.mapCacheKey(tenantId) }),
      c.namespace('feature_flags').delete({ key: this.singleCacheKey(tenantId, flag) }),
    ])
  }
}
