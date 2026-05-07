import { getConfig } from '../../config.js'
import type { TenantModelContract } from '../../types/contracts.js'
import type {
  DestroyOptions,
  IsolationDriver,
  IsolationDriverName,
  MigrateOptions,
  MigrateResult,
} from './driver.js'
import { assertSafeIdentifier } from './identifier.js'

const MAX_TENANT_CONNECTIONS = 50

/**
 * Lazily resolve `db` so unit tests don't drag the Lucid runtime — and
 * the `await app.booted(...)` inside `@adonisjs/lucid/services/db` —
 * into the test process.
 */
async function lucid() {
  const [{ default: db }, { default: app }, { MigrationRunner }] = await Promise.all([
    import('@adonisjs/lucid/services/db'),
    import('@adonisjs/core/services/app'),
    import('@adonisjs/lucid/migration'),
  ])
  return { db, app, MigrationRunner }
}

/**
 * Database-per-tenant PostgreSQL isolation. Each tenant gets its own
 * top-level database. Provision runs `CREATE DATABASE`, destroy runs
 * `DROP DATABASE` (after terminating active connections), connect clones
 * the template connection's config and overrides the `database` field.
 *
 * Trade-offs vs `schema-pg`:
 *   - Stronger isolation at the OS/process level (per-tenant tablespaces,
 *     stats, vacuum schedules).
 *   - Higher per-tenant overhead — one database registration in PG, more
 *     resources for connection pooling.
 *   - The role used by the template connection must have `CREATEDB`
 *     privilege; `CREATE DATABASE` cannot run inside a transaction.
 */
export default class DatabasePgDriver implements IsolationDriver {
  readonly name: IsolationDriverName = 'database-pg'
  readonly #lru = new Map<string, number>()
  readonly #templateConnectionName: string
  readonly #databasePrefix: string | undefined

  constructor(opts: { templateConnectionName?: string; databasePrefix?: string } = {}) {
    this.#templateConnectionName = opts.templateConnectionName ?? 'tenant'
    this.#databasePrefix = opts.databasePrefix
  }

  connectionName(tenantId: string): string {
    assertSafeIdentifier(tenantId, 'tenant id')
    return `${getConfig().tenantConnectionNamePrefix}${tenantId}`
  }

  databaseName(tenant: TenantModelContract | string): string {
    const id = typeof tenant === 'string' ? tenant : tenant.id
    assertSafeIdentifier(id, 'tenant id')
    const prefix = this.#databasePrefix ?? getConfig().tenantSchemaPrefix
    return `${prefix}${id}`
  }

  async provision(tenant: TenantModelContract): Promise<void> {
    const dbName = this.databaseName(tenant)
    const { db } = await lucid()
    const exists = await db.rawQuery('SELECT 1 FROM pg_database WHERE datname = ?', [dbName])
    const found = Array.isArray(exists.rows) ? exists.rows.length > 0 : (exists as any).length > 0
    if (!found) {
      // CREATE DATABASE cannot run in a transaction; rawQuery is fine.
      // dbName has already been validated by databaseName().
      await db.rawQuery(`CREATE DATABASE "${dbName}"`)
    }
    await this.connect(tenant)
  }

  async destroy(tenant: TenantModelContract, opts: DestroyOptions = {}): Promise<void> {
    const dbName = this.databaseName(tenant)
    await this.disconnect(tenant)
    if (opts.keepData) return
    const { db } = await lucid()
    // Terminate stragglers so DROP DATABASE doesn't fail with "is being
    // accessed by other users". Safe even if no sessions exist.
    await db.rawQuery(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = ? AND pid <> pg_backend_pid()`,
      [dbName]
    )
    await db.rawQuery(`DROP DATABASE IF EXISTS "${dbName}"`)
  }

  async reset(tenant: TenantModelContract): Promise<void> {
    await this.destroy(tenant)
    await this.provision(tenant)
  }

  async connect(tenant: TenantModelContract) {
    const { db } = await lucid()
    const name = this.connectionName(tenant.id)

    if (db.manager.has(name)) {
      this.#touch(name)
      return db.connection(name)
    }

    const template = db.manager.get(this.#templateConnectionName)?.config
    if (!template) {
      throw new Error(
        `DatabasePgDriver: template connection "${this.#templateConnectionName}" not found in db.manager. ` +
          `Configure it in config/database.ts.`
      )
    }

    db.manager.add(name, this.#cloneConfigForTenant(template, tenant))
    this.#touch(name)
    this.#evictIfNeeded(db)

    return db.connection(name)
  }

  async disconnect(tenant: TenantModelContract): Promise<void> {
    const { db } = await lucid()
    const name = this.connectionName(tenant.id)
    this.#lru.delete(name)
    if (db.manager.has(name)) {
      // `release` closes the pool and unregisters the connection;
      // `close` only ends the pool and would leak the registration.
      await db.manager.release(name)
    }
  }

  async migrate(
    tenant: TenantModelContract,
    opts: MigrateOptions
  ): Promise<MigrateResult> {
    const { db, app, MigrationRunner } = await lucid()
    // Make sure the connection is registered before the migrator looks it up.
    await this.connect(tenant)
    const runner = new MigrationRunner(db, app, {
      ...opts,
      connectionName: this.connectionName(tenant.id),
    })
    await runner.run()
    if (runner.error) throw runner.error
    return {
      executed: runner.migratedFiles ? Object.keys(runner.migratedFiles).length : 0,
    }
  }

  /**
   * Clone the template connection config, dropping any tenant-schema-only
   * options (`searchPath`) and overriding `connection.database` with the
   * tenant's database name.
   */
  #cloneConfigForTenant(
    template: any,
    tenant: TenantModelContract
  ): any {
    const cloned = { ...template, connection: { ...(template.connection ?? {}) } }
    cloned.connection.database = this.databaseName(tenant)
    delete cloned.searchPath
    return cloned
  }

  #touch(name: string): void {
    this.#lru.delete(name)
    this.#lru.set(name, Date.now())
  }

  #evictIfNeeded(db: { manager: { release(name: string): Promise<void> } }): void {
    if (this.#lru.size <= MAX_TENANT_CONNECTIONS) return
    const oldest = this.#lru.keys().next().value
    if (!oldest) return
    this.#lru.delete(oldest)
    db.manager.release(oldest).catch(() => {})
  }
}
