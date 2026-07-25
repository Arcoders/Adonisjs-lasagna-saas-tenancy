import { getConfig } from '../../config.js'
import { getActiveDriver } from './active_driver.js'
import { resolveTenantRepository } from '../resolve_tenant_repository.js'
import { resolveOperationalConnectionBudget } from './operational_budget.js'
import { mapWithConcurrency } from '../../utils/concurrency.js'
import type { IsolationDriver } from './driver.js'
import type { TenantModelContract } from '../../types/contracts.js'
import type { WarmPoolConfig } from '../../types/config/isolation.js'

const lazyLogger = () =>
  import('@adonisjs/core/services/logger').then((m) => m.default).catch(() => null)

/** How many connections to pre-open per tenant when `warmPool.count` is unset. */
export const DEFAULT_WARM_POOL_COUNT = 1

export interface WarmPoolResult {
  /** Whether the warm pool is enabled. */
  enabled: boolean
  /** How many declared tenants were resolved and attempted. */
  requested: number
  /** How many warmed successfully. */
  warmed: number
  /** How many failed (and were skipped, fail-closed). */
  failed: number
}

/** Injectable seams so the warm logic is unit-testable without an app/Lucid. */
export interface WarmPoolDeps {
  getDriver?: () => Promise<IsolationDriver>
  listTenants?: (ids: string[]) => Promise<TenantModelContract[]>
}

/**
 * F2 — the connection WARM POOL. Pre-opens connections for a set of
 * OPERATOR-declared hot tenants so their first request skips the cold-connection
 * cliff (connection registration + physical open) that an idle tenant otherwise
 * pays on its first query.
 *
 * Two safety properties, both structural:
 *  - The tenant set is only ever the operator-declared `warmPool.tenants` list or
 *    the operator-provided `selectTenants` hook, resolved once at boot in the
 *    app's own context. It is NEVER derived from request input, so an attacker
 *    cannot force the process to warm arbitrary tenants (a warm DoS).
 *  - Warming goes through the CAPPED `connect()` on the operational path
 *    (`bypassSoftCap`), so the absolute connection ceiling (S2) still refuses it,
 *    and the whole run is bounded to the operational connection budget. It fails
 *    closed: a per-tenant warm failure is logged and skipped, never thrown, so
 *    warming can never break boot or a request.
 *
 * Container-resolved singleton (wired in `isolationWiring`). Idempotent: warming a
 * tenant whose connection is already registered is a cheap cache hit.
 */
export default class WarmPoolService {
  constructor(private readonly deps: WarmPoolDeps = {}) {}

  async warmAll(): Promise<WarmPoolResult> {
    const cfg = getConfig().isolation.warmPool
    if (!cfg?.enabled) return { enabled: false, requested: 0, warmed: 0, failed: 0 }

    try {
      const ids = await this.#declaredTenantIds(cfg)
      if (ids.length === 0) return { enabled: true, requested: 0, warmed: 0, failed: 0 }

      const tenants = await this.#resolveTenants(ids)
      const driver = await (this.deps.getDriver ?? getActiveDriver)()
      const count = Math.max(1, cfg.count ?? DEFAULT_WARM_POOL_COUNT)
      // Bound warming CONCURRENCY to the operational budget: warming can never open
      // more connections at once than the budget (itself clamped to the ceiling).
      const budget = resolveOperationalConnectionBudget()

      const outcomes = await mapWithConcurrency(tenants, budget, (tenant) =>
        this.#warmOne(driver, tenant, count)
      )
      const warmed = outcomes.filter(Boolean).length
      return { enabled: true, requested: tenants.length, warmed, failed: tenants.length - warmed }
    } catch (error) {
      // The declaration/resolution step failed (a bad selectTenants hook, a repo
      // outage). Warming is best-effort, so log and degrade rather than break boot.
      const logger = await lazyLogger()
      logger?.warn(
        { err: (error as Error)?.message ?? String(error) },
        'multitenancy: warm-pool run failed before any tenant was warmed; skipping (fail-closed)'
      )
      return { enabled: true, requested: 0, warmed: 0, failed: 0 }
    }
  }

  async #declaredTenantIds(cfg: WarmPoolConfig): Promise<string[]> {
    if (typeof cfg.selectTenants === 'function') {
      const ids = await cfg.selectTenants()
      return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id.length > 0) : []
    }
    return (cfg.tenants ?? []).filter((id) => typeof id === 'string' && id.length > 0)
  }

  async #resolveTenants(ids: string[]): Promise<TenantModelContract[]> {
    if (this.deps.listTenants) return this.deps.listTenants(ids)
    const repo = await resolveTenantRepository()
    return repo.whereIn(ids)
  }

  async #warmOne(
    driver: IsolationDriver,
    tenant: TenantModelContract,
    count: number
  ): Promise<boolean> {
    try {
      // Operational path: bypass the SOFT cap, but the absolute ceiling still
      // refuses (throws TenantConnectionLimitException), which the catch degrades.
      const client = await driver.connect(tenant, { bypassSoftCap: true })
      // Force physical opens with `count` trivial queries. `SELECT 1` touches no
      // table, so it is safe even for an unprovisioned or empty tenant schema.
      await Promise.all(Array.from({ length: count }, () => client.rawQuery('SELECT 1')))
      return true
    } catch (error) {
      const logger = await lazyLogger()
      logger?.warn(
        { tenantId: tenant.id, err: (error as Error)?.message ?? String(error) },
        'multitenancy: warm-pool failed to warm a tenant connection; skipping (fail-closed)'
      )
      return false
    }
  }
}
