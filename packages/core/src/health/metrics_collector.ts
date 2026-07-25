import app from '@adonisjs/core/services/app'
import CircuitBreakerService from '../services/circuit_breaker_service.js'
import TenantQueueService from '../services/tenant_queue_service.js'
import { collectTenantPoolStats } from '../services/doctor/checks/connection_pool_check.js'
import { resolveTenantRepository } from '../services/resolve_tenant_repository.js'
import { getConfig } from '../config.js'
import { opCommittedKey, opHoldsKey, opAmtKey, periodToday } from '../services/quota/keys.js'
import { snapshotIsthmusCounters } from '../isthmus/audit.js'
import { TENANT_STATUSES } from '../types/contracts.js'
import type { TenantModelContract } from '../types/contracts.js'
import type { MetricsSnapshot, QuotaCeilingStat } from './metrics_exporter.js'

const lazyRedis = () =>
  import('@adonisjs/redis/services/main').then((m) => m.default).catch(() => null)

// Single-sourced from the status tuple so a new status is counted automatically.
const STATUSES = TENANT_STATUSES

interface CollectOptions {
  /** Skip the tenants registry query (useful when DB is unreachable). */
  includeTenants?: boolean
  /** Skip queue stats lookup (BullMQ can be slow). */
  includeQueues?: boolean
}

const startedAt = Date.now()

export async function collectSnapshot(options: CollectOptions = {}): Promise<MetricsSnapshot> {
  const { includeTenants = true, includeQueues = true } = options

  const tenantsByStatus: Record<string, number> = {}
  for (const s of STATUSES) tenantsByStatus[s] = 0
  let tenantsTotal = 0

  // The /metrics endpoint must always respond: it's polled by Prometheus
  // and a hard failure cascades into alerts about the alerting system. So
  // every section below catches and surfaces zeros on error, but logs a
  // warn so the degradation is visible.
  if (includeTenants) {
    try {
      const repo = await resolveTenantRepository()
      // Prefer the O(1) aggregate: the scrape only needs counts, so a host that
      // implements countByStatus lets us avoid loading (and hydrating) every
      // tenant row on every Prometheus poll. Fall back to the full scan only when
      // the repo doesn't provide it.
      if (typeof repo.countByStatus === 'function') {
        const byStatus = await repo.countByStatus({ includeDeleted: true })
        for (const [status, count] of Object.entries(byStatus)) {
          if (typeof count !== 'number') continue
          tenantsByStatus[status] = (tenantsByStatus[status] ?? 0) + count
          tenantsTotal += count
        }
      } else {
        const tenants = await repo.all({ includeDeleted: true })
        tenantsTotal = tenants.length
        for (const t of tenants as TenantModelContract[]) {
          tenantsByStatus[t.status] = (tenantsByStatus[t.status] ?? 0) + 1
        }
      }
    } catch (err) {
      await warn('tenants_unavailable', err)
    }
  }

  let circuits = {}
  try {
    const cb = await app.container.make(CircuitBreakerService)
    circuits = cb.getAllMetrics()
  } catch (err) {
    await warn('circuit_breaker_service_unavailable', err)
  }

  let queues: any[] = []
  if (includeQueues) {
    try {
      // Resolve the singleton so the map reflects queues this process has
      // dispatched to (a fresh `new TenantQueueService()` always reported an
      // empty map). Per-process by design; scrape every instance for a full
      // fleet view.
      const qs = await app.container.make(TenantQueueService)
      queues = await qs.getAllStats()
    } catch (err) {
      await warn('queue_stats_unavailable', err)
    }
  }

  // Tenant pool saturation is always exposed (observability by default), even
  // though the readiness GATE on it is opt-in. Cheap in-memory read; best-effort.
  let poolSaturation: MetricsSnapshot['poolSaturation'] = []
  try {
    poolSaturation = (await collectTenantPoolStats()) ?? []
  } catch (err) {
    await warn('pool_saturation_unavailable', err)
  }

  // Operator-global ceiling utilisation, DERIVED at scrape from live Redis (never
  // stored). Bounded O(#quotas): the enforced quotas come from config, and each
  // reads only its shared operator keys, never a per-tenant scan.
  let quotaCeilings: QuotaCeilingStat[] = []
  try {
    quotaCeilings = await collectQuotaCeilings()
  } catch (err) {
    await warn('quota_ceilings_unavailable', err)
  }

  return {
    tenantsTotal,
    tenantsByStatus,
    circuits,
    queues,
    poolSaturation,
    quotaCeilings,
    // In-memory monotonic counters; synchronous and infallible by contract.
    isthmus: snapshotIsthmusCounters(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  }
}

/**
 * Read the operator ceiling utilisation for every quota that declares one. The
 * set of quotas is enumerable from `plans.operatorCeiling` (a `Record`), so this
 * is O(#quotas) (a handful of `GET`/`ZRANGE`/`HMGET`) with no tenant fan-out.
 * Outstanding is recomputed from the live hold members (derive, never store),
 * matching how `reserve()` itself computes the effective ceiling.
 */
async function collectQuotaCeilings(): Promise<QuotaCeilingStat[]> {
  const ceilings = getConfig().plans?.operatorCeiling
  if (!ceilings) return []
  const quotas = Object.keys(ceilings)
  if (quotas.length === 0) return []
  const redis = await lazyRedis()
  if (!redis) return []

  const day = periodToday()
  const out: QuotaCeilingStat[] = []
  for (const quota of quotas) {
    const ceiling = Number(ceilings[quota])
    const committed = Number(await redis.get(opCommittedKey(day, quota))) || 0

    let outstanding = 0
    const members = await redis.zrange(opHoldsKey(day, quota), 0, -1)
    if (members.length > 0) {
      const amounts = await redis.hmget(opAmtKey(day, quota), ...members)
      for (const amt of amounts) {
        if (!amt) continue
        const [worst, settled] = String(amt).split(':').map(Number)
        outstanding += Math.max(0, (worst || 0) - (settled || 0))
      }
    }

    const used = committed + outstanding
    const utilization = Number.isFinite(ceiling) && ceiling > 0 ? used / ceiling : 0
    out.push({
      quota,
      ceiling: Number.isFinite(ceiling) ? ceiling : 0,
      committed,
      outstanding,
      utilization,
    })
  }
  return out
}

async function warn(kind: string, err: unknown): Promise<void> {
  const message = (err as Error)?.message ?? String(err)
  try {
    const logger = await app.container.make('logger').catch(() => undefined)
    if (logger) {
      logger.warn(
        { collector: 'health.metrics', kind, error: message },
        'multitenancy: metrics collector degraded — surfacing zeros for this section'
      )
      return
    }
  } catch {
    // Logger itself is broken. Fall through to console as a last resort.
  }
  console.warn(`[multitenancy] metrics collector ${kind}: ${message}`)
}
