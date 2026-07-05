import { getConfig } from '../../config.js'
import { getActiveDriver } from './active_driver.js'
import { resolveTenantRepository } from '../resolve_tenant_repository.js'
import { PGVECTOR_EXTENSION, PGVECTOR_EXTENSION_SCHEMA } from './pgvector.js'
import type { IsolationDriver } from './driver.js'
import type { TenantRepositoryContract } from '../../types/contracts.js'

/**
 * pgvector provisioning (SEAM-5). The vector store needs the PostgreSQL `vector`
 * extension before any embeddings table can declare a `vector(N)` column.
 * `CREATE EXTENSION` requires superuser (or a specifically granted role), so it
 * is treated as an operator/provisioning step run under a PRIVILEGED connection
 * (`isolation.provisionConnectionName`), decoupled from the app's request role
 * which stays least-privilege and never installs extensions.
 *
 * Placement is dispatched by the active driver, which is equivalent to the
 * physical storage shape:
 *   - `database-pg`: each tenant has its own database, so the extension is
 *     installed in EACH tenant database (the privileged connection is cloned per
 *     database).
 *   - `schema-pg` / `rowscope-pg`: tenants share one database, so the extension
 *     is installed once on that shared database.
 *   - `sqlite-memory`: pgvector is not applicable; skipped.
 *
 * This is idempotent (`CREATE EXTENSION IF NOT EXISTS`) and doubles as the
 * backfill for pre-existing databases, driven by the `tenant:vector:provision`
 * command.
 */

export { PGVECTOR_EXTENSION, PGVECTOR_EXTENSION_SCHEMA }

const lazyDb = () => import('@adonisjs/lucid/services/db').then((m) => m.default)

/**
 * Install pgvector into its dedicated schema (idempotent). The schema is created
 * first so `WITH SCHEMA` can land the `vector` type + operator classes where a
 * schema-pg tenant connection's search_path (which appends this schema) can
 * resolve them, without putting `public` on the tenant path.
 */
async function installVectorExtension(conn: {
  rawQuery: (sql: string) => Promise<unknown>
}): Promise<void> {
  // safe-sql: PGVECTOR_EXTENSION_SCHEMA is a fixed module constant, never user input (a schema name cannot be a bind parameter).
  await conn.rawQuery(`CREATE SCHEMA IF NOT EXISTS ${PGVECTOR_EXTENSION_SCHEMA}`)
  // safe-sql: both identifiers are fixed module constants, never user input (a DDL schema/extension name cannot be a bind parameter).
  await conn.rawQuery(
    `CREATE EXTENSION IF NOT EXISTS ${PGVECTOR_EXTENSION} WITH SCHEMA ${PGVECTOR_EXTENSION_SCHEMA}`
  )
}

// Monotonic per-process suffix so two concurrent provision runs never share a
// throwaway connection name (which would let one run's release close the other's
// pool mid-DDL).
let provisionSeq = 0

/** Minimal logger shape (satisfied by an ace command's `this.logger`). */
export interface ProvisionLogger {
  info(message: string): void
  warning?(message: string): void
}

export interface VectorProvisionOptions {
  /** Report what would run without issuing any DDL. */
  dryRun?: boolean
  /** Restrict to these tenant ids (database-pg only). Omit for all tenants. */
  tenantIds?: string[]
  logger?: ProvisionLogger
}

export interface VectorProvisionSummary {
  driver: string
  /** `central` = one shared database; `per-database` = one per tenant db; `skipped` = not applicable. */
  scope: 'central' | 'per-database' | 'skipped'
  /** How many databases were (or would be) provisioned successfully. */
  provisioned: number
  /** How many databases could not be provisioned (unreachable/locked); the run continued. */
  failed: number
  dryRun: boolean
}

/** Seams for tests to inject a fake active driver, Lucid db, and tenant repo. */
export interface VectorProvisionDeps {
  getDriver?: () => Promise<IsolationDriver>
  getDb?: () => Promise<any>
  getRepo?: () => Promise<TenantRepositoryContract>
}

/** The Lucid connection used for privileged provisioning DDL (`CREATE EXTENSION`). */
export function provisionConnectionName(): string {
  const cfg = getConfig()
  return cfg.isolation?.provisionConnectionName ?? cfg.centralConnectionName
}

/**
 * Install the pgvector extension where the active driver stores tenant data.
 * Fail-closed by nature: `CREATE EXTENSION` under a role without the privilege
 * raises a clear PostgreSQL error rather than silently continuing.
 */
export async function provisionVectorExtension(
  opts: VectorProvisionOptions = {},
  deps: VectorProvisionDeps = {}
): Promise<VectorProvisionSummary> {
  const dryRun = opts.dryRun ?? false
  const log = opts.logger
  const driver = await (deps.getDriver ?? getActiveDriver)()
  const db = await (deps.getDb ?? lazyDb)()
  const connName = provisionConnectionName()

  if (driver.name === 'sqlite-memory') {
    log?.info('sqlite-memory driver: pgvector is not applicable, skipping.')
    return { driver: driver.name, scope: 'skipped', provisioned: 0, failed: 0, dryRun }
  }

  // Privilege-separation caveat: the DDL should run under a role distinct from
  // the app's request-serving role. With no dedicated connection configured it
  // falls back to centralConnectionName (which the app also uses), so warn the
  // operator to configure a privileged connection for production.
  if (getConfig().isolation?.provisionConnectionName === undefined) {
    log?.warning?.(
      `pgvector: provisioning on the central connection "${connName}", which the app also uses. ` +
        `Set isolation.provisionConnectionName to a dedicated privileged role so the app role ` +
        `stays least-privilege.`
    )
  }

  // database-pg: the extension must exist in EACH tenant database. Clone the
  // privileged provision connection onto each tenant database and install there
  // (the tenant's own connection uses the least-privilege app role, which cannot
  // run CREATE EXTENSION). One unreachable/locked tenant database must not abort
  // the backfill for the rest.
  if (driver.name === 'database-pg') {
    const databaseName = (driver as unknown as { databaseName?: (t: unknown) => string })
      .databaseName
    if (typeof databaseName !== 'function') {
      throw new Error(
        `pgvector provisioning: the active "database-pg" driver does not expose ` +
          `databaseName(tenant); a custom driver must implement it to be provisioned per database.`
      )
    }
    const repo = await (deps.getRepo ?? resolveTenantRepository)()
    const tenants =
      opts.tenantIds && opts.tenantIds.length > 0
        ? await repo.whereIn(opts.tenantIds, true)
        : await repo.all({ includeDeleted: false })

    let provisioned = 0
    let failed = 0
    for (const tenant of tenants) {
      const dbName = databaseName.call(driver, tenant)
      if (dryRun) {
        log?.info(
          `would CREATE EXTENSION ${PGVECTOR_EXTENSION} WITH SCHEMA ${PGVECTOR_EXTENSION_SCHEMA} in database "${dbName}"`
        )
        provisioned++
        continue
      }
      try {
        await withProvisionConnection(db, connName, dbName, (conn) => installVectorExtension(conn))
        log?.info(
          `CREATE EXTENSION ${PGVECTOR_EXTENSION} WITH SCHEMA ${PGVECTOR_EXTENSION_SCHEMA} in database "${dbName}"`
        )
        provisioned++
      } catch (error) {
        failed++
        log?.warning?.(`pgvector: FAILED on database "${dbName}": ${(error as Error).message}`)
      }
    }
    return { driver: driver.name, scope: 'per-database', provisioned, failed, dryRun }
  }

  // schema-pg / rowscope-pg: one shared database, provision it once.
  if (driver.name === 'schema-pg' || driver.name === 'rowscope-pg') {
    if (dryRun) {
      log?.info(
        `would CREATE EXTENSION ${PGVECTOR_EXTENSION} WITH SCHEMA ${PGVECTOR_EXTENSION_SCHEMA} on connection "${connName}"`
      )
      return { driver: driver.name, scope: 'central', provisioned: 1, failed: 0, dryRun }
    }
    await installVectorExtension(db.connection(connName))
    log?.info(
      `CREATE EXTENSION ${PGVECTOR_EXTENSION} WITH SCHEMA ${PGVECTOR_EXTENSION_SCHEMA} on connection "${connName}"`
    )
    return { driver: driver.name, scope: 'central', provisioned: 1, failed: 0, dryRun }
  }

  // Unknown/custom driver: its storage shape is unknown, so do nothing rather
  // than guess a central install that might target the wrong place.
  log?.warning?.(
    `pgvector: unknown isolation driver "${driver.name}"; provision the vector extension ` +
      `manually where this driver stores tenant data.`
  )
  return { driver: driver.name, scope: 'skipped', provisioned: 0, failed: 0, dryRun }
}

/**
 * Run `fn` against the privileged provision connection cloned onto `dbName`.
 * Clones the connection config, overrides the database (dropping any
 * schema-only `searchPath`), registers a throwaway Lucid connection, and
 * releases it afterwards, mirroring how `DatabasePgDriver` targets a tenant db.
 */
async function withProvisionConnection(
  db: any,
  provisionConn: string,
  dbName: string,
  fn: (conn: any) => Promise<unknown>
): Promise<void> {
  const template = db.manager.get(provisionConn)?.config
  if (!template) {
    throw new Error(
      `pgvector provisioning: connection "${provisionConn}" is not registered in the Lucid ` +
        `manager. Configure a privileged provisioning connection and set ` +
        `isolation.provisionConnectionName (or centralConnectionName).`
    )
  }
  const tempName = `__vector_provision_${dbName}_${provisionSeq++}`
  const cloned = { ...template, connection: { ...(template.connection ?? {}) } }
  cloned.connection.database = dbName
  delete cloned.searchPath
  db.manager.add(tempName, cloned)
  try {
    await fn(db.connection(tempName))
  } finally {
    if (db.manager.has(tempName)) await db.manager.release(tempName)
  }
}
