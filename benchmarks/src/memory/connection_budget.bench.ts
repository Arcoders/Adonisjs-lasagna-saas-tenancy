import type { ApplicationService } from '@adonisjs/core/types'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { zeroMetric, type BenchResult } from '../harness/runner.js'
import { activeDriver, tenantRefs, ensureBackofficeSchema } from '../harness/provision.js'
import {
  snapshotConnections,
  pgBackendCount,
  memorySnapshot,
  disconnectAllTenants,
} from '../harness/introspect.js'
import { sizes } from '../harness/config.js'

const GROUP = 'connection_budget'

// The in-use-aware LRU only evicts connections OUTSIDE the grace window — it
// refuses to sever a connection that might be serving a request. A tight
// synthetic provisioning loop touches every connection "just now", so under the
// default 30s grace nothing is evictable and the pool grows to N. That is the
// documented "exceed the cap rather than sever an active request" behavior
// (and the churn tier proves it stays leak-free). To MEASURE steady-state cap
// enforcement here, we shrink the grace so connections age out between touches
// and the cap binds — which is what `peak ≈ maxTenantConnections × poolMax`
// describes once traffic is no longer bursting.
const BUDGET_GRACE_MS = 50

/**
 * Provision + touch N tenants and record the open connection count, the live
 * pg backend count, and RSS/heap. The point: open tenant connections stay
 * bounded by `maxTenantConnections` (+ grace) regardless of how large N grows,
 * validating `peak ≈ maxTenantConnections × poolMax`. For rowscope-pg there are
 * no per-tenant connections, so the count stays flat at 0 (one shared client).
 */
export async function runConnectionBudget(app: ApplicationService, db: any): Promise<BenchResult[]> {
  const driver = await activeDriver(app)
  await ensureBackofficeSchema(db)
  const cfg: any = getConfig()
  cfg.isolation = cfg.isolation ?? {}
  cfg.isolation.evictionGracePeriodMs = BUDGET_GRACE_MS
  const cap = cfg.isolation.maxTenantConnections ?? 50

  const results: BenchResult[] = []
  for (const count of sizes.budget.counts) {
    await disconnectAllTenants(db)
    const refs = tenantRefs(count)
    for (const ref of refs) {
      await driver.provision(ref as any) // ensure storage + register a connection
      const conn = await driver.connect(ref as any)
      await conn.rawQuery('SELECT 1') // force a real backend so pools actually open
    }

    const snap = snapshotConnections(db)
    const backends = await pgBackendCount(db)
    const mem = memorySnapshot()

    results.push(
      zeroMetric(
        `N=${count} tenants`,
        {
          tenants: count,
          cap,
          tenantConnectionsOpen: snap.tenantOpen,
          totalConnectionsOpen: snap.totalOpen,
          pgBackends: backends,
          rssMB: mem.rssMB,
          heapUsedMB: mem.heapUsedMB,
          withinBudget: snap.tenantOpen <= cap * 1.5 ? 'PASS' : 'FAIL',
        },
        GROUP
      )
    )
  }
  return results
}
