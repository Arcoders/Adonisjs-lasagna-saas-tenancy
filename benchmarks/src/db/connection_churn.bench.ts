import type { ApplicationService } from '@adonisjs/core/types'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import type { IsolationDriver } from '@adonisjs-lasagna/saas-tenancy/services'
import { measureLatency, summarize, type BenchResult } from '../harness/runner.js'
import { activeDriver, seedAll } from '../harness/provision.js'
import { snapshotConnections, pgBackendCount, disconnectAllTenants } from '../harness/introspect.js'
import { sizes } from '../harness/config.js'
import {
  clientFor,
  selectMarker,
  insertIdentifiableNote,
  selectWrites,
  type Ref,
} from './queries.js'

const GROUP = 'connection_churn'

/** One in WRITE_EVERY churn ops is an insert, so the write path is churned too. */
const WRITE_EVERY = 5

/** Live-mutate the open-connection cap; the LRU reads it lazily each evict. */
function setCap(cap: number): void {
  const cfg: any = getConfig()
  cfg.isolation = cfg.isolation ?? {}
  cfg.isolation.maxTenantConnections = cap
}

async function churnLoad(
  driver: IsolationDriver,
  db: any,
  refs: Ref[],
  concurrency: number,
  totalOps: number
): Promise<{ samples: number[]; writeOps: number }> {
  const samples: number[] = []
  let next = 0
  let writeOps = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= totalOps) return
      const ref = refs[i % refs.length]
      const t0 = process.hrtime.bigint()
      const conn = await clientFor(driver, db, ref)
      // Mix writes into the churn so the insert path (connect + search_path +
      // INSERT) is exercised under churn too, not just reads.
      if (i % WRITE_EVERY === 0) {
        await insertIdentifiableNote(conn, driver, ref, i)
        writeOps++
      } else {
        await selectMarker(conn, driver, ref)
      }
      samples.push(Number(process.hrtime.bigint() - t0))
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return { samples, writeOps }
}

/** Every tenant must see only its own marker row. Returns the leak count (0 = pass). */
async function countLeaks(driver: IsolationDriver, db: any, refs: Ref[]): Promise<number> {
  let leaks = 0
  for (const ref of refs) {
    const conn = await clientFor(driver, db, ref)
    const rows: Array<{ title: string }> = await selectMarker(conn, driver, ref)
    for (const row of rows) {
      if (row.title !== `marker:${ref.id}`) leaks++
    }
  }
  return leaks
}

/**
 * Every churn-written row a tenant reads back must be its own (`cw:<id>:…`).
 * Catches a misrouted INSERT under churn (schema-pg/database-pg). For rowscope
 * the read-back is predicate-scoped, so this is a complement to the HTTP
 * isolation tier, which exercises the real request path. Returns leak count.
 */
async function countWriteLeaks(driver: IsolationDriver, db: any, refs: Ref[]): Promise<number> {
  let leaks = 0
  for (const ref of refs) {
    const conn = await clientFor(driver, db, ref)
    const rows: Array<{ title: string }> = await selectWrites(conn, driver, ref)
    for (const row of rows) {
      if (!row.title.startsWith(`cw:${ref.id}:`)) leaks++
    }
  }
  return leaks
}

/**
 * Churn the connection pool across many more distinct tenants than the cap, at
 * concurrency, and record: p99 latency vs the single-tenant baseline, the open
 * connection count (must stay ≈ cap, never N), and a hard cross-tenant leakage
 * assertion (the scenario the in-use-aware LRU exists to prevent). Swept over
 * maxTenantConnections. (Precise evict/over-cap counters live in the tier-1
 * connection_lru micro bench, which can observe the private LRU directly.)
 */
export async function runConnectionChurn(app: ApplicationService, db: any): Promise<BenchResult[]> {
  const driver = await activeDriver(app)
  const results: BenchResult[] = []
  const C = sizes.churn.concurrency

  for (const cap of sizes.churn.caps) {
    setCap(cap)
    const M = cap * 2
    const { refs } = await seedAll(app, db, { tenants: M, rows: 50 })

    // Start each cap from a clean connection slate so the open-connection count
    // reflects this churn run, not connections left registered by a prior phase
    // (e.g. the cold-connection test) that the 30s grace would otherwise keep.
    await disconnectAllTenants(db)

    const baseline = await measureLatency(
      `cap=${cap} single-tenant SELECT (baseline)`,
      300,
      async () => {
        const conn = await clientFor(driver, db, refs[0])
        await selectMarker(conn, driver, refs[0])
      },
      { group: GROUP, meta: { cap } }
    )

    const { samples: churnSamples, writeOps } = await churnLoad(
      driver,
      db,
      refs,
      C,
      sizes.churn.opsPerStep
    )
    const open = snapshotConnections(db).tenantOpen
    const backends = await pgBackendCount(db)
    const leaks = await countLeaks(driver, db, refs)
    const writeLeaks = await countWriteLeaks(driver, db, refs)

    const churn = summarize(`cap=${cap} churn read+write (M=${M}, C=${C})`, churnSamples, {
      group: GROUP,
    })
    const degradationPct =
      baseline.ns.p99 > 0 ? ((churn.ns.p99 - baseline.ns.p99) / baseline.ns.p99) * 100 : 0
    churn.meta = {
      cap,
      tenants: M,
      concurrency: C,
      baselineP99ns: Math.round(baseline.ns.p99),
      churnP99ns: Math.round(churn.ns.p99),
      p99DegradationPct: Math.round(degradationPct * 10) / 10,
      tenantConnectionsOpen: open,
      pgBackends: backends,
      writeOps,
      crossTenantLeaks: leaks,
      leakageCheck: leaks === 0 ? 'PASS' : 'FAIL',
      crossTenantWriteLeaks: writeLeaks,
      writeIsolationCheck: writeLeaks === 0 ? 'PASS' : 'FAIL',
    }

    results.push(baseline, churn)
  }
  return results
}
