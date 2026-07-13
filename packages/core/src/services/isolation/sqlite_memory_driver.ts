import { getConfig } from '../../config.js'
import type { TenantModelContract } from '../../types/contracts.js'
import { ISOLATION_CONTRACT_VERSION } from './driver.js'
import type {
  DestroyOptions,
  IsolationDriverName,
  MigrateOptions,
  MigrateResult,
  ProvisionableDriver,
  TableLocation,
} from './driver.js'
import { assertSafeIdentifier } from '../../isthmus/guarded_identifier.js'
import { runTenantMigrations } from './tenant_migration_runner.js'

/**
 * Lazily resolve `db` to keep the Lucid runtime out of unit tests that only
 * exercise pure helpers. Mirrors the `lucid()` helper from the other drivers.
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
 * Testing-only isolation driver: each tenant gets its own in-memory SQLite
 * database. Provisioning is a no-op at the storage layer (SQLite creates the
 * DB on first connect); destroy releases the Lucid connection so the OS
 * reclaims the in-memory pages.
 *
 * Limitations (intentional, this is a TEST driver):
 *   - No backup/restore. The `tenant:backup` command will refuse to run when
 *     this driver is active.
 *   - No read replicas.
 *   - No persistence across process restarts.
 *   - SQLite SQL dialect ≠ PostgreSQL, so schema features (CTEs in DML, JSONB,
 *     RETURNING semantics) may behave differently. Use this driver for fast
 *     unit/integration suites; rely on the PG drivers for production parity.
 *
 * Requires `better-sqlite3` to be installed (declared as an optional peer
 * dependency). The driver lazy-imports it via Lucid; a missing dep surfaces
 * as a clear "client not installed" error from Lucid itself.
 */
export default class SqliteMemoryDriver implements ProvisionableDriver {
  readonly name: IsolationDriverName = 'sqlite-memory'
  readonly contractVersion = ISOLATION_CONTRACT_VERSION

  connectionName(tenantId: string): string {
    assertSafeIdentifier(tenantId, 'tenant id')
    return `${getConfig().tenantConnectionNamePrefix}${tenantId}`
  }

  tableLocation(tenant: TenantModelContract): TableLocation {
    // The in-memory database selected by the connection IS the namespace; there
    // is no schema or database to qualify. connectionName() asserts the id.
    return {
      kind: 'connection',
      connectionName: this.connectionName(tenant.id),
    }
  }

  async provision(tenant: TenantModelContract): Promise<void> {
    // Touch the connection so the in-memory DB is created and registered.
    await this.connect(tenant)
  }

  async destroy(tenant: TenantModelContract, opts: DestroyOptions = {}): Promise<void> {
    await this.disconnect(tenant)
    // `keepData` is meaningless for in-memory storage. Releasing the
    // connection drops the data either way. We honor the flag for API
    // symmetry with the PG drivers but log nothing.
    void opts
  }

  async reset(tenant: TenantModelContract): Promise<void> {
    await this.disconnect(tenant)
    await this.connect(tenant)
  }

  async connect(tenant: TenantModelContract, _opts: { bypassHardCap?: boolean } = {}) {
    const { db } = await lucid()
    const name = this.connectionName(tenant.id)

    if (db.manager.has(name)) {
      // No identity seal here (unlike schema-pg/database-pg): the connection name,
      // derived from the validated tenant id, IS the whole identity. There is no
      // shared searchPath or database field a stale registration could re-point at
      // another tenant, and the in-memory database is bound to this connection
      // alone. A name collision is impossible for distinct valid tenant ids.
      return db.connection(name)
    }

    db.manager.add(name, {
      client: 'better-sqlite3',
      connection: {
        filename: ':memory:',
      },
      useNullAsDefault: true,
    } as any)

    return db.connection(name)
  }

  async disconnect(tenant: TenantModelContract): Promise<void> {
    const { db } = await lucid()
    const name = this.connectionName(tenant.id)
    if (db.manager.has(name)) {
      await db.manager.release(name)
    }
  }

  async migrate(tenant: TenantModelContract, opts: MigrateOptions): Promise<MigrateResult> {
    // Ensure the connection exists before the runner asks for it.
    await this.connect(tenant)
    return runTenantMigrations(this.connectionName(tenant.id), opts)
  }
}
