import type { ApplicationService } from '@adonisjs/core/types'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { patchIsolationConfig } from '../harness/runtime_config.js'
import { zeroMetric, type BenchResult } from '../harness/runner.js'
import { activeDriver, tenantRefs, ensureBackofficeSchema } from '../harness/provision.js'
import { isProvisionableDriver } from '../../../packages/core/build/src/services/isolation/driver.js'
import {
  snapshotConnections,
  pgBackendCount,
  pgBackendCountAllDatabases,
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
export async function runConnectionBudget(
  app: ApplicationService,
  db: any
): Promise<BenchResult[]> {
  const driver = await activeDriver(app)
  await ensureBackofficeSchema(db)
  patchIsolationConfig({ evictionGracePeriodMs: BUDGET_GRACE_MS })
  const cap = getConfig().isolation?.maxTenantConnections ?? 50

  // database-pg provisions a real database per tenant (CREATE DATABASE), so cap
  // the swept counts to keep the run sane — the per-database backend budget is
  // already visible at a modest N. schema-pg/rowscope provision cheaply.
  const counts =
    driver.name === 'database-pg'
      ? sizes.budget.counts.filter((n) => n <= 200)
      : sizes.budget.counts

  const results: BenchResult[] = []
  for (const count of counts) {
    await disconnectAllTenants(db)
    const refs = tenantRefs(count)
    for (const ref of refs) {
      // ensure storage (provisionable drivers) + register a connection
      if (isProvisionableDriver(driver)) await driver.provision(ref as any)
      const conn = await driver.connect(ref as any)
      await conn.rawQuery('SELECT 1') // force a real backend so pools actually open
    }

    const snap = snapshotConnections(db)
    // database-pg keeps each tenant in its own database, so the per-tenant
    // backends do not show under current_database(); count across all databases.
    const isDatabasePg = driver.name === 'database-pg'
    const backends = isDatabasePg ? await pgBackendCountAllDatabases(db) : await pgBackendCount(db)
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
          pgBackendsScope: isDatabasePg ? 'all-databases' : 'current-database',
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
