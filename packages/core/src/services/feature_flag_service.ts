import TenantFeatureFlag from '../models/satellites/tenant_feature_flag.js'
import { getCache } from '../utils/cache.js'
import { DateTime } from 'luxon'

/** A flag's stored state, as returned by {@link FeatureFlagService.getFlag}. */
export interface FeatureFlagRecord {
  enabled: boolean
  config: Record<string, unknown> | null
  /** ISO 8601 expiry, or `null` for no expiry. */
  expiresAt: string | null
}

export default class FeatureFlagService {
  private mapCacheKey(tenantId: string) {
    // `ffm2:` (not `ff_map:`) — the cached value shape changed from a bare
    // boolean to a FeatureFlagRecord. The versioned key keeps a rolling deploy
    // from letting a new pod read an old pod's boolean-shaped entry (and the
    // reverse). Pre-bump entries age out under their own old key.
    return `ffm2:${tenantId}`
  }

  /**
   * Authoritative boolean evaluation. A flag is enabled only when it is stored
   * enabled AND not past its `expiresAt`. Expiry is compared at read time
   * against the stored timestamp, so it is exact regardless of the cache TTL.
   */
  async isEnabled(tenantId: string, flag: string): Promise<boolean> {
    const f = await this.getFlag(tenantId, flag)
    if (!f || !f.enabled) return false
    if (f.expiresAt && DateTime.fromISO(f.expiresAt) <= DateTime.now()) return false
    return true
  }

  /**
   * The raw stored record for one flag (or `null` if it isn't set). This is a
   * faithful data accessor — it does NOT apply expiry; use {@link isEnabled}
   * for the boolean decision. Handy when you only need the `config` (e.g. a
   * rollout percentage) without listing every flag.
   */
  async getFlag(tenantId: string, flag: string): Promise<FeatureFlagRecord | null> {
    const map = await this.#getMap(tenantId)
    return map[flag] ?? null
  }

  async #getMap(tenantId: string): Promise<Record<string, FeatureFlagRecord>> {
    return getCache()
      .namespace('feature_flags')
      .getOrSet({
        key: this.mapCacheKey(tenantId),
        ttl: '60s',
        factory: async () => {
          const rows = await TenantFeatureFlag.query().where('tenant_id', tenantId)
          return Object.fromEntries(
            rows.map((r) => [
              r.flag,
              { enabled: r.enabled, config: r.config, expiresAt: r.expiresAt?.toISO() ?? null },
            ])
          )
        },
      }) as Promise<Record<string, FeatureFlagRecord>>
  }

  async set(
    tenantId: string,
    flag: string,
    enabled: boolean,
    config?: Record<string, unknown>,
    expiresAt?: DateTime | null
  ): Promise<TenantFeatureFlag> {
    const row = await TenantFeatureFlag.updateOrCreate(
      { tenantId, flag },
      { enabled, config: config ?? null, expiresAt: expiresAt ?? null }
    )
    await getCache()
      .namespace('feature_flags')
      .delete({ key: this.mapCacheKey(tenantId) })
    return row
  }

  async listForTenant(tenantId: string): Promise<TenantFeatureFlag[]> {
    return TenantFeatureFlag.query().where('tenant_id', tenantId).orderBy('flag')
  }

  async delete(tenantId: string, flag: string): Promise<void> {
    await TenantFeatureFlag.query().where('tenant_id', tenantId).where('flag', flag).delete()
    await getCache()
      .namespace('feature_flags')
      .delete({ key: this.mapCacheKey(tenantId) })
  }
}
