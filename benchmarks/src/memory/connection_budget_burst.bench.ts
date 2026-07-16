import type { ApplicationService } from '@adonisjs/core/types'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { patchIsolationConfig } from '../harness/runtime_config.js'
import { zeroMetric, type BenchResult } from '../harness/runner.js'
import { activeDriver, tenantRefs, ensureBackofficeSchema } from '../harness/provision.js'
import {
  snapshotConnections,
  pgBackendCount,
  memorySnapshot,
  disconnectAllTenants,
} from '../harness/introspect.js'
import { sizes } from '../harness/config.js'

const GROUP = 'connection_budget_burst'

/** The package's production default eviction grace (connection_lru.ts). */
const PROD_GRACE_MS = 30_000

/**
 * The HONEST budget bench. Unlike `connection_budget.bench.ts` (which shrinks
 * the eviction grace to 50ms so the cap binds), this one keeps the PRODUCTION
 * default grace (30s) and drives a concurrent burst across distinct tenants,
 * the realistic shape. Under that grace the in-use-aware LRU refuses to evict
 * anything recently touched and the pool grows toward N, NOT toward the cap.
 *
 * Result published, not asserted: "open ≈ N, not cap" is the truth we want
 * visible. The hard assertion is the saturation/recovery scenario: when N×pool
 * exceeds Postgres `max_connections`, connecting must fail cleanly and the
 * system must recover once the load drops.
 */

async function showMaxConnections(db: any): Promise<number> {
  try {
    const res = await db.rawQuery('SHOW max_connections')
    const rows = Array.isArray(res.rows) ? res.rows : res
    return Number(rows?.[0]?.max_connections ?? 100)
  } catch {
    return 100
  }
}

function classifyConnError(err: unknown): string {
  const msg = ((err as Error)?.message ?? String(err)).toLowerCase()
  if (msg.includes('too many clients')) return 'too_many_clients'
  if (msg.includes('remaining connection slots')) return 'no_connection_slots'
  if (msg.includes('timeout')) return 'pool_timeout'
  return (err as { code?: string })?.code ?? 'unknown'
}

export async function runConnectionBudgetBurst(
  app: ApplicationService,
  db: any
): Promise<BenchResult[]> {
  const driver = await activeDriver(app)
  // This tier connects without provisioning (SELECT 1 needs no schema), which is
  // fine for schema-pg but would fail for database-pg (the per-tenant database
  // would not exist) and is meaningless for rowscope (one shared connection).
  // The LRU grace behavior it measures is identical for schema-pg/database-pg
  // (same ConnectionLru), so schema-pg is the representative case.
  if (driver.name !== 'schema-pg') return []
  await ensureBackofficeSchema(db)

  // Pin the PRODUCTION default grace explicitly: the steady budget bench may
  // have shrunk it to 50ms in this same process; we want the honest 30s here.
  patchIsolationConfig({ evictionGracePeriodMs: PROD_GRACE_MS })
  const cap = getConfig().isolation?.maxTenantConnections ?? 50

  const maxConn = await showMaxConnections(db)
  // Leave headroom for central + backoffice + a margin so the honest-budget
  // measurement itself doesn't trip the ceiling (that's the saturation test's job).
  const safeMax = Math.max(cap + 1, Math.floor(maxConn * 0.7) - 16)

  const results: BenchResult[] = []
  const W = sizes.burst.workers

  // 1) Honest budget under the production grace, concurrent burst.
  const honestCounts = sizes.budget.counts.filter((n) => n <= safeMax)
  for (const count of honestCounts) {
    await disconnectAllTenants(db)
    const refs = tenantRefs(count)

    let next = 0
    const worker = async () => {
      for (;;) {
        const i = next++
        if (i >= refs.length) return
        const conn = await driver.connect(refs[i] as any)
        await conn.rawQuery('SELECT 1')
      }
    }
    await Promise.all(Array.from({ length: W }, () => worker()))

    const snap = snapshotConnections(db)
    const backends = await pgBackendCount(db)
    const mem = memorySnapshot()
    results.push(
      zeroMetric(
        `N=${count} burst (grace=${PROD_GRACE_MS}ms, default)`,
        {
          tenants: count,
          cap,
          openDuringBurst: snap.tenantOpen,
          pgBackends: backends,
          rssMB: mem.rssMB,
          // Honest verdict surfaced (NOT a gate fail): the cap does not bound
          // open connections under the default grace.
          capBounds: snap.tenantOpen <= cap ? 'cap-holds' : 'cap-exceeded',
          openVsCap: `${snap.tenantOpen}/${cap}`,
        },
        GROUP
      )
    )
  }

  // 2) Saturation + recovery: climb tenant connections until Postgres rejects,
  //    then drain and prove a fresh connect recovers.
  await disconnectAllTenants(db)
  const saturateTo = Math.min(sizes.burst.saturateTo, maxConn + 32)
  const refs = tenantRefs(saturateTo)
  let firstFailureAtN = 0
  let errorClass = 'none'
  let maxOpenReached = 0
  try {
    for (const [i, ref] of refs.entries()) {
      try {
        const conn = await driver.connect(ref as any)
        await conn.rawQuery('SELECT 1')
        maxOpenReached = snapshotConnections(db).tenantOpen
      } catch (err) {
        firstFailureAtN = i + 1
        errorClass = classifyConnError(err)
        break
      }
    }
  } finally {
    await disconnectAllTenants(db)
  }

  // Recovery: after draining, a fresh tenant connect must succeed (and quickly).
  const t0 = process.hrtime.bigint()
  let recovered = false
  try {
    const conn = await driver.connect(refs[0] as any)
    await conn.rawQuery('SELECT 1')
    recovered = true
  } catch {
    recovered = false
  } finally {
    await disconnectAllTenants(db)
  }
  const recoveredWithinMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6)

  // The gate fails only if saturation did NOT fail cleanly OR we didn't recover.
  // No failure within saturateTo is fine (the box had headroom); a hang or a
  // non-recovering pool is not.
  const sawFailure = firstFailureAtN > 0
  const failClosedCheck = !sawFailure || recovered ? 'PASS' : 'FAIL'
  results.push(
    zeroMetric(
      `saturation probe (to N=${saturateTo}, max_connections=${maxConn})`,
      {
        cap,
        maxConnections: maxConn,
        maxOpenReached,
        firstFailureAtN: sawFailure ? firstFailureAtN : 'none-within-N',
        errorClass,
        recovered: recovered ? 'yes' : 'no',
        recoveredWithinMs,
        failClosedCheck,
      },
      GROUP
    )
  )

  // 3) Hard-cap scenario: with isolation.enforceConnectionCap on, connect() must
  //    REFUSE a new tenant beyond the cap (503) instead of exceeding it. Run
  //    sequentially over 3x the cap so the result is deterministic: exactly `cap`
  //    open, the rest rejected. Restore the flag afterwards.
  //
  // Drain the driver's LRU first. disconnectAllTenants only releases from Lucid's
  // manager; the driver's internal LRU still holds entries from the earlier
  // phases AND the steady budget bench (same driver singleton), which would make
  // atHardLimit() see a full registry and reject everything. driver.disconnect()
  // clears both. The refs are deterministic, so disconnecting a superset is safe.
  const drainN = Math.max(...sizes.budget.counts, sizes.burst.saturateTo, cap * 3)
  for (const ref of tenantRefs(drainN)) await driver.disconnect(ref as any)

  patchIsolationConfig({ enforceConnectionCap: true })
  await disconnectAllTenants(db)
  const hcTenants = cap * 3
  let opened = 0
  let rejected = 0
  try {
    for (const ref of tenantRefs(hcTenants)) {
      try {
        const conn = await driver.connect(ref as any)
        await conn.rawQuery('SELECT 1')
        opened++
      } catch (err) {
        if ((err as { code?: string })?.code === 'E_TENANT_CONNECTION_LIMIT') rejected++
        else throw err
      }
    }
  } finally {
    patchIsolationConfig({ enforceConnectionCap: false }) // never leak the flag to later tiers
  }
  const openWithHardCap = snapshotConnections(db).tenantOpen
  await disconnectAllTenants(db)
  results.push(
    zeroMetric(
      `hard cap (enforceConnectionCap=true, N=${hcTenants}, cap=${cap})`,
      {
        cap,
        tenants: hcTenants,
        openWithHardCap,
        opened,
        rejected,
        // The cap is a real bound now: open never exceeds it and the excess is
        // refused (rather than the pool growing toward N as in scenario 1).
        hardCapCheck: openWithHardCap <= cap && rejected > 0 ? 'PASS' : 'FAIL',
      },
      GROUP
    )
  )

  return results
}
