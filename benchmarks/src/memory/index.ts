/**
 * Tier 4 — memory + connection budget. Boots the bench fixture headless and
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
import { runCatalogBloat } from './catalog_bloat.bench.js'

const app = await bootBenchApp()
let exitCode = 0
try {
  const db = await getDb()
  const pg = await pgVersion(db)

  const results: BenchResult[] = [...(await runConnectionBudget(app, db))]

  // Catalog bloat is a property of the Postgres catalog, independent of the
  // isolation driver. Run it once, under schema-pg, to avoid 3× redundant work.
  if (DRIVER === 'schema-pg') {
    results.push(...(await runCatalogBloat(app, db)))
  }

  printMetricResults(`Tier 4 — memory + budget (driver: ${DRIVER})`, results)
  writeResult('mem', results, { pgVersion: pg })
} catch (error) {
  exitCode = 1
  // eslint-disable-next-line no-console
  console.error(error)
} finally {
  await terminateBenchApp(app)
}
process.exit(exitCode)
