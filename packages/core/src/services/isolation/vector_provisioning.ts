import { getConfig } from '../../config.js'
import { getActiveDriver } from './active_driver.js'
import { assertSafeIdentifier } from './identifier.js'
import { resolveTenantRepository } from '../resolve_tenant_repository.js'
import { PGVECTOR_EXTENSION, PGVECTOR_EXTENSION_SCHEMA } from './pgvector.js'
import type { IsolationDriver } from './driver.js'
import type { TenantRepositoryContract } from '../../types/contracts.js'

/**
 * pgvector provisioning. The vector store needs the PostgreSQL `vector`
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
 * Install a PostgreSQL extension (idempotent). When `schema` is set the schema is
 * created first and the extension lands in it (`WITH SCHEMA`), so a tenant
 * connection whose search_path appends that schema resolves the extension's types
 * without putting `public` on the tenant path (this is exactly how pgvector is
 * installed). Without a schema, the extension installs into the connection's
 * default location.
 *
 * Both identifiers are interpolated into DDL (they cannot be bind parameters), so
 * the caller MUST have run {@link assertSafeIdentifier} on them first.
 * {@link provisionExtension} does.
 */
export async function installExtension(
  conn: { rawQuery: (sql: string) => Promise<unknown> },
  name: string,
  schema?: string
): Promise<void> {
  if (schema) {
    // safe-sql: schema is assertSafeIdentifier-validated by provisionExtension (a schema name cannot be a bind parameter).
    await conn.rawQuery(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
    // safe-sql: both identifiers are assertSafeIdentifier-validated by provisionExtension (a DDL schema/extension name cannot be a bind parameter).
    await conn.rawQuery(`CREATE EXTENSION IF NOT EXISTS ${name} WITH SCHEMA ${schema}`)
    return
  }
  // safe-sql: name is assertSafeIdentifier-validated by provisionExtension (an extension name cannot be a bind parameter).
  await conn.rawQuery(`CREATE EXTENSION IF NOT EXISTS ${name}`)
}

// Monotonic per-process suffix so two concurrent provision runs never share a
// throwaway connection name (which would let one run's release close the other's
// pool mid-DDL).
let provisionSeq = 0

/**
 * A PostgreSQL extension a plugin declares its tenants need. Wired via
 * `definePlugin({ provisionExtensions })`, which registers an `after('provision')`
 * hook that installs it into each newly-provisioned tenant's storage. The name and
 * optional schema are validated as safe DDL identifiers before any `CREATE`.
 */
export interface ProvisionExtensionSpec {
  /** The extension name, e.g. `vector`, `postgis`, `pg_trgm`. */
  readonly name: string
  /** Optional dedicated schema to install it into (created if absent). */
  readonly schema?: string
}

/** Minimal logger shape (satisfied by an ace command's `this.logger`). */
export interface ProvisionLogger {
  info(message: string): void
  warning?(message: string): void
}

export interface VectorProvisionOptions {
  /** Report what would run without issuing any DDL. */
  dryRun?: boolean
  /** Restrict to these tenant ids (database-pg only). Omit for all tenants. */
  tenantIds?: string[] | undefined
  logger?: ProvisionLogger | undefined
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

/** Summary of a {@link provisionExtension} run: the vector summary plus the
 *  extension name (so a multi-extension caller can tell runs apart). */
export interface ExtensionProvisionSummary extends VectorProvisionSummary {
  /** The extension this summary is for. */
  extension: string
}

/**
 * Install a PostgreSQL extension where the active driver stores tenant data.
 * The generic engine behind {@link provisionVectorExtension}: it
 * validates the identifiers, then dispatches by driver: per tenant database for
 * `database-pg`, once on the shared database for `schema-pg`/`rowscope-pg`, and
 * skipped for `sqlite-memory` / unknown drivers.
 *
 * Fail-closed by nature: `CREATE EXTENSION` under a role without the privilege
 * raises a clear PostgreSQL error. Per-database it is fail-open across tenants (one
 * unreachable database is counted in `failed` and the run continues).
 */
export async function provisionExtension(
  spec: ProvisionExtensionSpec,
  opts: VectorProvisionOptions = {},
  deps: VectorProvisionDeps = {}
): Promise<ExtensionProvisionSummary> {
  // Both go into raw DDL (they cannot be bind parameters), so validate BEFORE any
  // connection work, so a hostile/typo'd name fails fast, not mid-DDL.
  assertSafeIdentifier(spec.name, 'extension name')
  if (spec.schema !== undefined) assertSafeIdentifier(spec.schema, 'extension schema')
  const name = spec.name
  const schema = spec.schema
  const ddl = schema ? `CREATE EXTENSION ${name} WITH SCHEMA ${schema}` : `CREATE EXTENSION ${name}`

  const dryRun = opts.dryRun ?? false
  const log = opts.logger
  const driver = await (deps.getDriver ?? getActiveDriver)()
  const db = await (deps.getDb ?? lazyDb)()
  const connName = provisionConnectionName()

  if (driver.name === 'sqlite-memory') {
    log?.info(`sqlite-memory driver: extension "${name}" is not applicable, skipping.`)
    return {
      extension: name,
      driver: driver.name,
      scope: 'skipped',
      provisioned: 0,
      failed: 0,
      dryRun,
    }
  }

  // Privilege-separation caveat: the DDL should run under a role distinct from
  // the app's request-serving role. With no dedicated connection configured it
  // falls back to centralConnectionName (which the app also uses), so warn the
  // operator to configure a privileged connection for production.
  if (getConfig().isolation?.provisionConnectionName === undefined) {
    log?.warning?.(
      `extension "${name}": provisioning on the central connection "${connName}", which the app ` +
        `also uses. Set isolation.provisionConnectionName to a dedicated privileged role so the ` +
        `app role stays least-privilege.`
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
        `extension provisioning: the active "database-pg" driver does not expose ` +
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
        log?.info(`would ${ddl} in database "${dbName}"`)
        provisioned++
        continue
      }
      try {
        await withProvisionConnection(db, connName, dbName, (conn) =>
          installExtension(conn, name, schema)
        )
        log?.info(`${ddl} in database "${dbName}"`)
        provisioned++
      } catch (error) {
        failed++
        log?.warning?.(
          `extension "${name}": FAILED on database "${dbName}": ${(error as Error).message}`
        )
      }
    }
    return {
      extension: name,
      driver: driver.name,
      scope: 'per-database',
      provisioned,
      failed,
      dryRun,
    }
  }

  // schema-pg / rowscope-pg: one shared database, provision it once.
  if (driver.name === 'schema-pg' || driver.name === 'rowscope-pg') {
    if (dryRun) {
      log?.info(`would ${ddl} on connection "${connName}"`)
      return {
        extension: name,
        driver: driver.name,
        scope: 'central',
        provisioned: 1,
        failed: 0,
        dryRun,
      }
    }
    await installExtension(db.connection(connName), name, schema)
    log?.info(`${ddl} on connection "${connName}"`)
    return {
      extension: name,
      driver: driver.name,
      scope: 'central',
      provisioned: 1,
      failed: 0,
      dryRun,
    }
  }

  // Unknown/custom driver: its storage shape is unknown, so do nothing rather
  // than guess a central install that might target the wrong place.
  log?.warning?.(
    `extension "${name}": unknown isolation driver "${driver.name}"; provision it manually where ` +
      `this driver stores tenant data.`
  )
  return {
    extension: name,
    driver: driver.name,
    scope: 'skipped',
    provisioned: 0,
    failed: 0,
    dryRun,
  }
}

/**
 * Install the pgvector extension where the active driver stores tenant data.
 * A thin adapter over {@link provisionExtension} pinned to the `vector` extension
 * in its dedicated schema; kept for the `tenant:vector:provision` command and the
 * AI satellite, with its original summary shape (no `extension` field).
 */
export async function provisionVectorExtension(
  opts: VectorProvisionOptions = {},
  deps: VectorProvisionDeps = {}
): Promise<VectorProvisionSummary> {
  const s = await provisionExtension(
    { name: PGVECTOR_EXTENSION, schema: PGVECTOR_EXTENSION_SCHEMA },
    opts,
    deps
  )
  return {
    driver: s.driver,
    scope: s.scope,
    provisioned: s.provisioned,
    failed: s.failed,
    dryRun: s.dryRun,
  }
}

/**
 * Run `fn` against the privileged provision connection cloned onto `dbName`.
 * Clones the connection config, overrides the database (dropping any
 * schema-only `searchPath`), registers a throwaway Lucid connection, and
 * releases it afterwards, mirroring how `DatabasePgDriver` targets a tenant db.
 * Exported so a plugin's own provisioning path can reuse the privileged-clone
 * machinery.
 */
export async function withProvisionConnection(
  db: any,
  provisionConn: string,
  dbName: string,
  fn: (conn: any) => Promise<unknown>
): Promise<void> {
  const template = db.manager.get(provisionConn)?.config
  if (!template) {
    throw new Error(
      `extension provisioning: connection "${provisionConn}" is not registered in the Lucid ` +
        `manager. Configure a privileged provisioning connection and set ` +
        `isolation.provisionConnectionName (or centralConnectionName).`
    )
  }
  const tempName = `__ext_provision_${dbName}_${provisionSeq++}`
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
