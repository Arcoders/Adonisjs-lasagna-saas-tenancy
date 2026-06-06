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
import TenantConnectionLimitException from '../../exceptions/tenant_connection_limit_exception.js'
import ConnectionLru, {
  DEFAULT_EVICTION_GRACE_MS,
  DEFAULT_MAX_TENANT_CONNECTIONS,
} from './connection_lru.js'

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
  readonly #templateConnectionName: string
  readonly #lru = new ConnectionLru({
    label: 'SchemaPgDriver',
    cap: () => getConfig().isolation?.maxTenantConnections ?? DEFAULT_MAX_TENANT_CONNECTIONS,
    graceMs: () => getConfig().isolation?.evictionGracePeriodMs ?? DEFAULT_EVICTION_GRACE_MS,
    hardCap: () => getConfig().isolation?.enforceConnectionCap ?? false,
    release: async (name) => {
      const { db } = await lucid()
      if (db.manager.has(name)) await db.manager.release(name)
    },
  })

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
    await this.connect(tenant, { bypassHardCap: true })
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
    await this.connect(tenant, { bypassHardCap: true })
  }

  async connect(tenant: TenantModelContract, opts: { bypassHardCap?: boolean } = {}) {
    const { db } = await lucid()
    const name = this.connectionName(tenant.id)

    if (db.manager.has(name)) {
      this.#lru.touch(name)
      return db.connection(name)
    }

    // Hard-cap admission control (opt-in) guards the request-serving path. The
    // provisioning/reset paths call connect() too and pass bypassHardCap, so a
    // momentarily full request-path budget can't refuse tenant onboarding (which
    // would also leave the freshly created schema orphaned). No-op unless
    // enforceConnectionCap.
    if (!opts.bypassHardCap && this.#lru.atHardLimit()) {
      throw new TenantConnectionLimitException()
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

    this.#lru.touch(name)
    this.#lru.evictIfNeeded()

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

  async migrate(tenant: TenantModelContract, opts: MigrateOptions): Promise<MigrateResult> {
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
}
