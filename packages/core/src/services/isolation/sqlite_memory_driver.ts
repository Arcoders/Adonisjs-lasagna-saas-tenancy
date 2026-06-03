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
 * Limitations (intentional — this is a TEST driver):
 *   - No backup/restore. The `tenant:backup` command will refuse to run when
 *     this driver is active.
 *   - No read replicas.
 *   - No persistence across process restarts.
 *   - SQLite SQL dialect ≠ PostgreSQL — schema features (CTEs in DML, JSONB,
 *     RETURNING semantics) may behave differently. Use this driver for fast
 *     unit/integration suites; rely on the PG drivers for production parity.
 *
 * Requires `better-sqlite3` to be installed (declared as an optional peer
 * dependency). The driver lazy-imports it via Lucid; a missing dep surfaces
 * as a clear "client not installed" error from Lucid itself.
 */
export default class SqliteMemoryDriver implements IsolationDriver {
  readonly name: IsolationDriverName = 'sqlite-memory'

  connectionName(tenantId: string): string {
    assertSafeIdentifier(tenantId, 'tenant id')
    return `${getConfig().tenantConnectionNamePrefix}${tenantId}`
  }

  async provision(tenant: TenantModelContract): Promise<void> {
    // Touch the connection so the in-memory DB is created and registered.
    await this.connect(tenant)
  }

  async destroy(tenant: TenantModelContract, opts: DestroyOptions = {}): Promise<void> {
    await this.disconnect(tenant)
    // `keepData` is meaningless for in-memory storage — releasing the
    // connection drops the data either way. We honor the flag for API
    // symmetry with the PG drivers but log nothing.
    void opts
  }

  async reset(tenant: TenantModelContract): Promise<void> {
    await this.disconnect(tenant)
    await this.connect(tenant)
  }

  async connect(tenant: TenantModelContract) {
    const { db } = await lucid()
    const name = this.connectionName(tenant.id)

    if (db.manager.has(name)) {
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
    const { db, app, MigrationRunner } = await lucid()
    // Ensure the connection exists before the runner asks for it.
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
}
