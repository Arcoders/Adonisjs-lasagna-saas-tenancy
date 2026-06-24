import TenantFeatureFlag from '../models/satellites/tenant_feature_flag.js'
import { getCache } from '../utils/cache.js'
import EvaluationStrategyRegistry, {
  DEFAULT_EVALUATION_STRATEGY,
} from './evaluation_strategy_registry.js'
import type { DateTime } from 'luxon'

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
   * Authoritative boolean evaluation. By default a flag is enabled only when it
   * is stored enabled AND not past its `expiresAt` (the built-in strategy).
   *
   * A flag may name a host-registered strategy via `config.strategy` (e.g. a
   * rollout-percentage or context-aware decision); pass `context` (a userId, a
   * request attribute) for those. The flag RECORD is cached (per-tenant map),
   * but the decision is computed PER CALL — a context-aware strategy is never
   * cached as a boolean, so one principal's result can't leak to another. A flag
   * with no `config.strategy` takes the fast default path (no registry lookup),
   * identical to legacy behavior.
   */
  async isEnabled(
    tenantId: string,
    flag: string,
    context?: Record<string, unknown>
  ): Promise<boolean> {
    const f = await this.getFlag(tenantId, flag)
    if (!f) return false

    const evalContext = { tenantId, flag, ...(context ?? {}) }
    const strategyName = typeof f.config?.strategy === 'string' ? f.config.strategy : undefined
    if (!strategyName) {
      return DEFAULT_EVALUATION_STRATEGY.evaluate(f, evalContext)
    }

    const registry = await this.#strategyRegistry()
    const strategy = registry?.get(strategyName) ?? DEFAULT_EVALUATION_STRATEGY
    return strategy.evaluate(f, evalContext)
  }

  /** Resolve the host strategy registry from the container, best-effort. */
  async #strategyRegistry(): Promise<EvaluationStrategyRegistry | undefined> {
    try {
      const app = (await import('@adonisjs/core/services/app')).default
      return await app.container.make(EvaluationStrategyRegistry)
    } catch {
      return undefined
    }
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
