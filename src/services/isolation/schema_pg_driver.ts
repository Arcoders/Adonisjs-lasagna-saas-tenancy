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
 * Lazily resolve `db` so unit tests that only exercise pure helpers
 * (connectionName/schemaName) don't drag the Lucid runtime — and the
 * `await app.booted(...)` inside `@adonisjs/lucid/services/db` — into
 * the test process. Read replicas use the same pattern.
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
 * Default isolation driver: each tenant gets its own PostgreSQL schema
 * (`tenant_<uuid>`) on a shared database. Connections are registered
 * lazily into Lucid's manager with a `searchPath` pointing at the
 * tenant's schema. An LRU bound caps how many simultaneous tenant
 * connections can stay open in the pool.
 */
export default class SchemaPgDriver implements IsolationDriver {
  readonly name: IsolationDriverName = 'schema-pg'
  readonly #lru = new Map<string, number>()
  readonly #templateConnectionName: string

  constructor(opts: { templateConnectionName?: string } = {}) {
    this.#templateConnectionName = opts.templateConnectionName ?? 'tenant'
  }

  connectionName(tenantId: string): string {
    assertSafeIdentifier(tenantId, 'tenant id')
    return `${getConfig().tenantConnectionNamePrefix}${tenantId}`
  }

  schemaName(tenant: TenantModelContract | string): string {
    const id = typeof tenant === 'string' ? tenant : tenant.id
    assertSafeIdentifier(id, 'tenant id')
    return `${getConfig().tenantSchemaPrefix}${id}`
  }

  async provision(tenant: TenantModelContract): Promise<void> {
    const schema = this.schemaName(tenant)
    const { db } = await lucid()
    await db.rawQuery(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
    await this.connect(tenant)
  }

  async destroy(tenant: TenantModelContract, opts: DestroyOptions = {}): Promise<void> {
    const schema = this.schemaName(tenant)
    await this.disconnect(tenant)
    if (opts.keepData) return
    const { db } = await lucid()
    await db.rawQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  }

  async reset(tenant: TenantModelContract): Promise<void> {
    const schema = this.schemaName(tenant)
    await this.disconnect(tenant)
    const { db } = await lucid()
    await db.rawQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await db.rawQuery(`CREATE SCHEMA "${schema}"`)
    await this.connect(tenant)
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
        `SchemaPgDriver: template connection "${this.#templateConnectionName}" not found in db.manager. ` +
          `Configure it in config/database.ts.`
      )
    }

    db.manager.add(name, {
      ...template,
      searchPath: [this.schemaName(tenant)],
    } as any)

    this.#touch(name)
    this.#evictIfNeeded(db)

    return db.connection(name)
  }

  async disconnect(tenant: TenantModelContract): Promise<void> {
    const { db } = await lucid()
    const name = this.connectionName(tenant.id)
    this.#lru.delete(name)
    if (db.manager.has(name)) {
      // `release` both closes the pool and unregisters the connection from
      // the manager. `close` only ends the pool — `manager.has()` would
      // still report true, leaking entries across `provision/destroy` cycles.
      await db.manager.release(name)
    }
  }

  async migrate(
    tenant: TenantModelContract,
    opts: MigrateOptions
  ): Promise<MigrateResult> {
    const { db, app, MigrationRunner } = await lucid()
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
