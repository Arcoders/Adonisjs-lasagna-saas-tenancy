/**
 * Tier 2: DB per-driver query latency + connection churn. Boots the bench
 * fixture headless (the drivers need a booted app), runs against real Postgres
 * for the driver selected by BENCH_DRIVER.
 *
 *   docker compose -f benchmarks/docker-compose.yml up -d
 *   BENCH_DRIVER=schema-pg npm run bench:db
 */
import { bootBenchApp, terminateBenchApp, getDb } from '../harness/ignitor.js'
import { printResults, type BenchResult } from '../harness/runner.js'
import { writeResult } from '../harness/results.js'
import { pgVersion } from '../harness/provision.js'
import { DRIVER } from '../harness/config.js'
import { runDriverQuery } from './driver_query.bench.js'
import { runConnectionChurn } from './connection_churn.bench.js'

const app = await bootBenchApp()
let exitCode = 0
try {
  const db = await getDb()
  const pg = await pgVersion(db)

  const results: BenchResult[] = [
    ...(await runDriverQuery(app, db)),
    ...(await runConnectionChurn(app, db)),
  ]

  printResults(`Tier 2 — DB (driver: ${DRIVER})`, results)
  writeResult('db', results, { pgVersion: pg })
} catch (error) {
  exitCode = 1

  console.error(error)
} finally {
  await terminateBenchApp(app)
}
process.exit(exitCode)
