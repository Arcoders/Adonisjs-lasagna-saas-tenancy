import type { ApplicationService } from '@adonisjs/core/types'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { measureLatency, zeroMetric, type BenchResult } from '../harness/runner.js'
import { activeDriver, provisionTenants, seedIdentifiableNotes } from '../harness/provision.js'
import { sizes } from '../harness/config.js'

const GROUP = 'catalog_bloat'
const SCHEMA_PREFIX = 'bench_cat_'

async function scalarInt(db: any, sql: string): Promise<number> {
  const res = await db.rawQuery(sql)
  const rows = Array.isArray(res.rows) ? res.rows : res
  return Number(rows?.[0]?.c ?? 0)
}

/**
 * Catalog-bloat curve done RIGHT.
 *
 * The previous version timed `EXPLAIN SELECT * FROM "bench_cat_0".t0 …`, a
 * fully-qualified name against an EMPTY toy table, always the first schema. That
 * bypasses exactly the cost catalog bloat imposes: PostgreSQL resolving an
 * UNqualified table name against `search_path` as the catalog grows, which is
 * how a real schema-pg tenant query works (`SET search_path` + bare `notes`).
 *
 * This version:
 *   - provisions a REAL, POPULATED probe tenant (its `notes` table via the
 *     tenant migration), and queries it UNqualified through the driver's
 *     search_path connection;
 *   - inflates pg_class with cheap toy schemas to reach K, then re-measures;
 *   - also times the old fully-qualified plan, so the delta is visible.
 *
 * For database-pg the catalog is PER-DATABASE (bounded and small); the bloat
 * risk there is the NUMBER of databases, not a giant pg_class (measured
 * separately). rowscope-pg has a single shared schema, so it is skipped.
 */
export async function runCatalogBloat(app: ApplicationService, db: any): Promise<BenchResult[]> {
  const driver = await activeDriver(app)
  if (driver.name === 'rowscope-pg') return [] // single shared schema; no per-tenant catalog growth

  if (driver.name === 'database-pg') return runDatabaseCatalog(app, db)
  return runSchemaCatalog(app, db)
}

async function runSchemaCatalog(app: ApplicationService, db: any): Promise<BenchResult[]> {
  const driver = await activeDriver(app)
  const T = sizes.catalog.tablesPerSchema
  const counts = [...sizes.catalog.schemaCounts].sort((a, b) => a - b)
  const maxK = counts[counts.length - 1] ?? 0
  const results: BenchResult[] = []

  // A real, populated probe tenant queried via search_path (the realistic path).
  const { refs } = await provisionTenants(app, db, 1)
  await seedIdentifiableNotes(app, db, refs, 200)
  const probe = refs[0]! // provisioned exactly one tenant above
  const schemaPrefix = getConfig().tenantSchemaPrefix ?? 'tenant_'
  const probeSchema = `${schemaPrefix}${probe.id}`
  const conn = await driver.connect(probe as any) // search_path = probe's schema

  let created = 0
  try {
    for (const K of counts) {
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

      // Realistic: UNqualified name, resolved via search_path on a populated table.
      const planSearchPath = await measureLatency(
        `K=${K} EXPLAIN via search_path`,
        100,
        () => conn.rawQuery('EXPLAIN SELECT * FROM notes WHERE id = 1'),
        { group: GROUP }
      )
      // Legacy: fully-qualified name (what the old bench measured).
      const planQualified = await measureLatency(
        `K=${K} EXPLAIN qualified (legacy)`,
        100,
        () => conn.rawQuery(`EXPLAIN SELECT * FROM "${probeSchema}".notes WHERE id = 1`),
        { group: GROUP }
      )
      const query = await measureLatency(
        `K=${K} query via search_path`,
        100,
        () => conn.rawQuery('SELECT * FROM notes WHERE id = 1'),
        { group: GROUP }
      )

      results.push(
        zeroMetric(
          `K=${K} schemas × ${T} tables (probe via search_path)`,
          {
            schemas: K,
            tablesPerSchema: T,
            pgClassRows,
            planSearchPathMedianNs: Math.round(planSearchPath.ns.median),
            planSearchPathP99Ns: Math.round(planSearchPath.ns.p99),
            planQualifiedMedianNs: Math.round(planQualified.ns.median),
            queryMedianNs: Math.round(query.ns.median),
            queryP99Ns: Math.round(query.ns.p99),
          },
          GROUP
        )
      )
    }
  } finally {
    for (let i = 0; i < Math.max(maxK, created); i++) {
      await db.rawQuery(`DROP SCHEMA IF EXISTS "${SCHEMA_PREFIX}${i}" CASCADE`).catch(() => {})
    }
  }

  return results
}

/**
 * database-pg: one database per tenant. The per-database catalog is small and
 * bounded; the scaling concern is the NUMBER of databases. Provision a real
 * probe tenant database, then report its (small) pg_class, the unqualified
 * plan/query cost inside it, and the global database count.
 */
async function runDatabaseCatalog(app: ApplicationService, db: any): Promise<BenchResult[]> {
  const driver = await activeDriver(app)
  const { refs } = await provisionTenants(app, db, 1)
  await seedIdentifiableNotes(app, db, refs, 200)
  const probe = refs[0]
  const conn = await driver.connect(probe as any) // routed to the tenant's own database

  const perDbPgClass = await scalarInt(conn, 'SELECT count(*)::int AS c FROM pg_class')
  const databases = await scalarInt(
    db,
    'SELECT count(*)::int AS c FROM pg_database WHERE datistemplate = false'
  )
  const plan = await measureLatency(
    'EXPLAIN via search_path (tenant database)',
    100,
    () => conn.rawQuery('EXPLAIN SELECT * FROM notes WHERE id = 1'),
    { group: GROUP }
  )
  const query = await measureLatency(
    'query via search_path (tenant database)',
    100,
    () => conn.rawQuery('SELECT * FROM notes WHERE id = 1'),
    { group: GROUP }
  )

  return [
    zeroMetric(
      'per-database catalog (database-pg)',
      {
        catalogModel: 'per-database (bounded); scaling risk is #databases, not pg_class',
        perDatabasePgClassRows: perDbPgClass,
        databasesProvisioned: databases,
        planMedianNs: Math.round(plan.ns.median),
        queryMedianNs: Math.round(query.ns.median),
      },
      GROUP
    ),
  ]
}
