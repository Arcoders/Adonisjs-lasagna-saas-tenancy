import type { ApplicationService } from '@adonisjs/core/types'
import { measureLatency, summarize, type BenchResult } from '../harness/runner.js'
import { activeDriver, seedAll, provisionTenants } from '../harness/provision.js'
import { sizes, CI_MODE } from '../harness/config.js'
import { clientFor, selectById, insertNote, selfJoin, firstId } from './queries.js'

const GROUP = 'driver_query'
const ITERS = CI_MODE ? 150 : 500
const COLD = CI_MODE ? 10 : 25

/**
 * Per-driver warm query latency (SELECT-by-id / INSERT / 2-table JOIN) plus the
 * cold-tenant first-query cost (a brand-new connection register for schema-pg /
 * database-pg; a no-op for rowscope-pg, which shares one connection).
 */
export async function runDriverQuery(app: ApplicationService, db: any): Promise<BenchResult[]> {
  const driver = await activeDriver(app)
  const { refs } = await seedAll(app, db, { tenants: sizes.db.tenants, rows: sizes.db.rows })
  const ref = refs[0]
  const conn = await clientFor(driver, db, ref)

  const seed = await firstId(conn, driver, ref)
  const someId = Number(seed?.id ?? 1)

  const results: BenchResult[] = [
    await measureLatency('SELECT by id', ITERS, () => selectById(conn, driver, ref, someId), {
      group: GROUP,
    }),
    await measureLatency('INSERT', ITERS, () => insertNote(conn, driver, ref), { group: GROUP }),
    await measureLatency('2-table self JOIN (limit 20)', ITERS, () => selfJoin(conn, driver, ref), {
      group: GROUP,
    }),
  ]

  if (driver.name === 'rowscope-pg') {
    results.push(
      summarize('cold-tenant first query (n/a for rowscope)', [0], {
        group: GROUP,
        meta: { note: 'rowscope shares one connection; no per-tenant cold cost' },
      })
    )
    return results
  }

  // Cold path: provision extra tenants, then time the first query on each after
  // forcing the connection out of the manager.
  const extra = await provisionTenants(app, db, sizes.db.tenants + COLD)
  const coldRefs = extra.refs.slice(sizes.db.tenants)
  const coldSamples: number[] = []
  for (const cold of coldRefs) {
    await driver.disconnect(cold as any)
    const t0 = process.hrtime.bigint()
    const c = await driver.connect(cold as any)
    await c.from('notes').limit(1)
    coldSamples.push(Number(process.hrtime.bigint() - t0))
  }
  results.push(summarize('cold-tenant first query', coldSamples, { group: GROUP }))
  return results
}
