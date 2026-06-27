import type { QueryClientContract } from '@adonisjs/lucid/types/database'
import { getConfig } from '../../config.js'
import type { TenantModelContract } from '../../types/contracts.js'
import { ISOLATION_CONTRACT_VERSION } from './driver.js'
import type {
  DestroyOptions,
  IsolationDriverName,
  MigrateOptions,
  MigrateResult,
  ProvisionableDriver,
} from './driver.js'
import { assertSafeIdentifier } from './identifier.js'
import TenantConnectionLimitException from '../../exceptions/tenant_connection_limit_exception.js'
import IsolationConfigException from '../../exceptions/isolation_config_exception.js'
import ConnectionLru, {
  DEFAULT_EVICTION_GRACE_MS,
  DEFAULT_MAX_TENANT_CONNECTIONS,
} from './connection_lru.js'

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
export default class DatabasePgDriver implements ProvisionableDriver {
  readonly name: IsolationDriverName = 'database-pg'
  readonly contractVersion = ISOLATION_CONTRACT_VERSION
  readonly #templateConnectionName: string
  readonly #databasePrefix: string | undefined
  readonly #lru = new ConnectionLru({
    label: 'DatabasePgDriver',
    cap: () => getConfig().isolation?.maxTenantConnections ?? DEFAULT_MAX_TENANT_CONNECTIONS,
    graceMs: () => getConfig().isolation?.evictionGracePeriodMs ?? DEFAULT_EVICTION_GRACE_MS,
    hardCap: () => getConfig().isolation?.enforceConnectionCap ?? false,
    release: async (name) => {
      const { db } = await lucid()
      if (db.manager.has(name)) await db.manager.release(name)
    },
  })

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

  enforce(_client: QueryClientContract, _tenantId: string): void {
    // No-op: each tenant has its own database, so the connection is the
    // boundary. Nothing to scope on the client.
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
    await this.connect(tenant, { bypassHardCap: true })
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

  /** Refresh the in-use grace window for a tenant's connection on every query. */
  markUsed(tenantId: string): void {
    const name = this.connectionName(tenantId)
    if (this.#lru.has(name)) this.#lru.touch(name)
  }

  async connect(tenant: TenantModelContract, opts: { bypassHardCap?: boolean } = {}) {
    const { db } = await lucid()
    const name = this.connectionName(tenant.id)

    // If this connection was just evicted, wait for its pool to finish draining
    // before deciding it's still registered — otherwise we'd re-adopt a closing
    // pool and queries would fail mid-flight.
    await this.#lru.settlePending(name)

    if (db.manager.has(name)) {
      this.#lru.touch(name)
      return db.connection(name)
    }

    // Hard-cap admission control (opt-in) guards the request-serving path. The
    // provisioning/migration paths call connect() too and pass bypassHardCap, so
    // a momentarily full request-path budget can't refuse tenant onboarding
    // (which would also leave the freshly created database orphaned). No-op
    // unless enforceConnectionCap.
    if (!opts.bypassHardCap && this.#lru.atHardLimit()) {
      throw new TenantConnectionLimitException()
    }

    const template = db.manager.get(this.#templateConnectionName)?.config
    if (!template) {
      throw new IsolationConfigException(
        `DatabasePgDriver: template connection "${this.#templateConnectionName}" not found in db.manager. ` +
          `Configure it in config/database.ts.`
      )
    }

    db.manager.add(name, this.#cloneConfigForTenant(template, tenant))
    this.#lru.touch(name)
    this.#lru.evictIfNeeded()

    return db.connection(name)
  }

  async disconnect(tenant: TenantModelContract): Promise<void> {
    const { db } = await lucid()
    const name = this.connectionName(tenant.id)
    this.#lru.delete(name)
    // If an eviction is already draining this pool, wait for it instead of
    // racing it with a second release (idempotent in Lucid, but the await
    // keeps the manager state deterministic for the `has()` check below).
    await this.#lru.settlePending(name)
    if (db.manager.has(name)) {
      // `release` closes the pool and unregisters the connection;
      // `close` only ends the pool and would leak the registration.
      await db.manager.release(name)
    }
  }

  async migrate(tenant: TenantModelContract, opts: MigrateOptions): Promise<MigrateResult> {
    const { db, app, MigrationRunner } = await lucid()
    // Make sure the connection is registered before the migrator looks it up.
    await this.connect(tenant, { bypassHardCap: true })
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
  #cloneConfigForTenant(template: any, tenant: TenantModelContract): any {
    const cloned = { ...template, connection: { ...(template.connection ?? {}) } }
    cloned.connection.database = this.databaseName(tenant)
    delete cloned.searchPath
    return cloned
  }
}
