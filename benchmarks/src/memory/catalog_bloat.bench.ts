import type { ApplicationService } from '@adonisjs/core/types'
import { measureLatency, zeroMetric, type BenchResult } from '../harness/runner.js'
import { sizes } from '../harness/config.js'

const GROUP = 'catalog_bloat'
const SCHEMA_PREFIX = 'bench_cat_'

async function scalarInt(db: any, sql: string): Promise<number> {
  const res = await db.rawQuery(sql)
  const rows = Array.isArray(res.rows) ? res.rows : res
  return Number(rows?.[0]?.c ?? 0)
}

/**
 * Create K schemas × T tables and chart how catalog size affects planning. The
 * curve behind the "catalog bloat slows planning" claim: pg_class row count,
 * the cost of planning a query (timed `EXPLAIN`, plan-only), and a
 * representative query latency, as K grows. K=5000 is local-only (slow); CI
 * caps at 1000. Schemas are dropped on the way out.
 */
export async function runCatalogBloat(app: ApplicationService, db: any): Promise<BenchResult[]> {
  const T = sizes.catalog.tablesPerSchema
  const counts = [...sizes.catalog.schemaCounts].sort((a, b) => a - b)
  const maxK = counts[counts.length - 1] ?? 0
  const results: BenchResult[] = []

  let created = 0
  try {
    for (const K of counts) {
      // Incrementally create schemas up to K (counts are ascending).
      for (; created < K; created++) {
        const schema = `${SCHEMA_PREFIX}${created}`
        await db.rawQuery(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
        for (let t = 0; t < T; t++) {
          await db.rawQuery(
            `CREATE TABLE IF NOT EXISTS "${schema}".t${t} (id serial PRIMARY KEY, val text)`
          )
        }
      }

      const pgClassRows = await scalarInt(db, 'SELECT count(*)::int AS c FROM pg_class')
      const sample = `${SCHEMA_PREFIX}0`
      const explain = await measureLatency(
        `K=${K} EXPLAIN (plan only)`,
        sizes.catalog.schemaCounts.length ? 100 : 100,
        () => db.rawQuery(`EXPLAIN SELECT * FROM "${sample}".t0 WHERE id = 1`),
        { group: GROUP }
      )
      const query = await measureLatency(
        `K=${K} representative query`,
        100,
        () => db.rawQuery(`SELECT * FROM "${sample}".t0 WHERE id = 1`),
        { group: GROUP }
      )

      results.push(
        zeroMetric(
          `K=${K} schemas × ${T} tables`,
          {
            schemas: K,
            tablesPerSchema: T,
            pgClassRows,
            explainMedianNs: Math.round(explain.ns.median),
            explainP99Ns: Math.round(explain.ns.p99),
            queryMedianNs: Math.round(query.ns.median),
            queryP99Ns: Math.round(query.ns.p99),
          },
          GROUP
        )
      )
    }
  } finally {
    // Tear down every schema we created, even on error.
    for (let i = 0; i < Math.max(maxK, created); i++) {
      await db.rawQuery(`DROP SCHEMA IF EXISTS "${SCHEMA_PREFIX}${i}" CASCADE`).catch(() => {})
    }
  }

  return results
}
