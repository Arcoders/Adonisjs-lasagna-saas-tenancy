/**
 * Tier 4: memory + connection budget. Boots the bench fixture headless and
 * runs against real Postgres for the driver selected by BENCH_DRIVER.
 *
 *   docker compose -f benchmarks/docker-compose.yml up -d
 *   BENCH_DRIVER=schema-pg npm run bench:mem
 */
import { bootBenchApp, terminateBenchApp, getDb } from '../harness/ignitor.js'
import { printMetricResults, type BenchResult } from '../harness/runner.js'
import { writeResult } from '../harness/results.js'
import { pgVersion } from '../harness/provision.js'
import { DRIVER } from '../harness/config.js'
import { runConnectionBudget } from './connection_budget.bench.js'
import { runConnectionBudgetBurst } from './connection_budget_burst.bench.js'
import { runCatalogBloat } from './catalog_bloat.bench.js'

const app = await bootBenchApp()
let exitCode = 0
try {
  const db = await getDb()
  const pg = await pgVersion(db)

  // Steady (grace shrunk to 50ms; cap binds) for continuity with the old number,
  // then the HONEST burst under the production 30s grace (open grows to N, not the cap)
  // plus the saturation/recovery probe. Run the burst LAST so its grace reset
  // doesn't affect the steady measurement.
  const results: BenchResult[] = [
    ...(await runConnectionBudget(app, db)),
    ...(await runConnectionBudgetBurst(app, db)),
  ]

  // Catalog is now driver-specific (schema-pg: search_path bloat curve;
  // database-pg: per-database catalog). The bench self-skips rowscope-pg.
  results.push(...(await runCatalogBloat(app, db)))

  printMetricResults(`Tier 4 — memory + budget (driver: ${DRIVER})`, results)
  writeResult('mem', results, { pgVersion: pg })
} catch (error) {
  exitCode = 1

  console.error(error)
} finally {
  await terminateBenchApp(app)
}
process.exit(exitCode)
