/**
 * `npm run bench:seed` — provision + seed the active driver's tenants directly,
 * so the HTTP tier (which serves a separate process) finds data already in the
 * database. The DB/memory tiers seed themselves in-process; this CLI is for the
 * HTTP tier and for ad-hoc local setup.
 *
 *   BENCH_DRIVER=schema-pg npm run bench:seed
 *   BENCH_DRIVER=rowscope-pg BENCH_DB_TENANTS=100 npm run bench:seed
 */
import { bootBenchApp, terminateBenchApp, getDb } from './ignitor.js'
import { seedAll } from './provision.js'
import { sizes, DRIVER } from './config.js'

const tenants = sizes.http.tenants
const rows = sizes.http.rows

const app = await bootBenchApp()
try {
  const db = await getDb()

  console.log(`Seeding ${tenants} tenants × ${rows} rows for driver "${DRIVER}"…`)
  const start = Date.now()
  const result = await seedAll(app, db, { tenants, rows })

  console.log(
    `Seeded ${result.ids.length} tenants in ${((Date.now() - start) / 1000).toFixed(1)}s.\n` +
      `First tenant id (for ad-hoc curl): ${result.ids[0]}`
  )
} finally {
  await terminateBenchApp(app)
}
process.exit(0)
