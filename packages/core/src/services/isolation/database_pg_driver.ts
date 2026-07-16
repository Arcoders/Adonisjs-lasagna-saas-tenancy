import { getConfig } from '../../config.js'
import type { TenantModelContract } from '../../types/contracts.js'
import type { DestroyOptions, IsolationDriverName, TableLocation } from './driver.js'
import { assertCachedConnectionIdentity } from './connection_identity_seal.js'
import { assertSafeIdentifier } from '../../isthmus/guarded_identifier.js'
import PooledPgDriver from './pooled_pg_driver.js'

/**
 * Database-per-tenant PostgreSQL isolation. Each tenant gets its own
 * top-level database. Provision runs `CREATE DATABASE`, destroy runs
 * `DROP DATABASE` (after terminating active connections), and the connection
 * config clones the template's and overrides the `database` field. The shared
 * {@link PooledPgDriver} base owns the bounded connection pool and the
 * connect/disconnect/markUsed/migrate flow.
 *
 * Trade-offs vs `schema-pg`:
 *   - Stronger isolation at the OS/process level (per-tenant tablespaces,
 *     stats, vacuum schedules).
 *   - Higher per-tenant overhead: one database registration in PG, more
 *     resources for connection pooling.
 *   - The role used by the template connection must have `CREATEDB`
 *     privilege; `CREATE DATABASE` cannot run inside a transaction.
 */
export default class DatabasePgDriver extends PooledPgDriver {
  readonly name: IsolationDriverName = 'database-pg'
  readonly #databasePrefix: string | undefined

  constructor(opts: { templateConnectionName?: string; databasePrefix?: string } = {}) {
    super({ templateConnectionName: opts.templateConnectionName, label: 'DatabasePgDriver' })
    this.#databasePrefix = opts.databasePrefix
  }

  databaseName(tenant: TenantModelContract | string): string {
    const id = typeof tenant === 'string' ? tenant : tenant.id
    assertSafeIdentifier(id, 'tenant id')
    const prefix = this.#databasePrefix ?? getConfig().tenantSchemaPrefix
    return `${prefix}${id}`
  }

  tableLocation(tenant: TenantModelContract): TableLocation {
    // databaseName() honors #databasePrefix identically to buildTenantConfig(), so
    // the placement can never disagree with where connect() actually routes; both
    // helpers assertSafeIdentifier the id.
    return {
      kind: 'database',
      database: this.databaseName(tenant),
      connectionName: this.connectionName(tenant.id),
    }
  }

  protected buildTenantConfig(template: any, tenant: TenantModelContract): any {
    // Clone the template config, dropping any tenant-schema-only options
    // (`searchPath`) and overriding `connection.database` with the tenant's
    // database name.
    const cloned = { ...template, connection: { ...(template.connection ?? {}) } }
    cloned.connection.database = this.databaseName(tenant)
    delete cloned.searchPath
    return cloned
  }

  protected verifyCachedConnection(
    tenant: TenantModelContract,
    cachedConfig: unknown,
    name: string
  ): void {
    // database-pg keys the seal on `connection.database`, the one field
    // buildTenantConfig overrides per tenant.
    const existing = cachedConfig as { connection?: { database?: unknown } } | undefined
    const expected = this.databaseName(tenant)
    const actual = existing?.connection?.database
    assertCachedConnectionIdentity({
      driverLabel: 'DatabasePgDriver',
      tenantId: tenant.id,
      connection: name,
      identityKind: 'database',
      expected,
      actualDisplay: JSON.stringify(actual),
      matches: actual === expected,
    })
  }

  async provision(tenant: TenantModelContract): Promise<void> {
    const dbName = this.databaseName(tenant)
    const { db } = await this.lucid()
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
    const { db } = await this.lucid()
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
}
