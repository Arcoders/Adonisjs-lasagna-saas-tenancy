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

async function lucid() {
  const { default: db } = await import('@adonisjs/lucid/services/db')
  return { db }
}

/**
 * Single-database row-scoping isolation. All tenants share one database and
 * one schema; per-tenant separation is enforced at query time by adding a
 * `WHERE tenant_id = ?` predicate. Use the `withTenantScope()` model mixin
 * to apply that predicate automatically.
 *
 * Trade-offs vs schema-pg / database-pg:
 *   - Cheapest provisioning: nothing happens at tenant create time.
 *   - Lower OS-level isolation; a missing scope leaks across tenants.
 *   - Migrations are central — `migrate()` is a no-op here.
 *
 * `destroy()` and `reset()` walk the configured `rowScopeTables` list and
 * run `DELETE FROM <table> WHERE <column> = ?` per table. Tables not on
 * the list are untouched, so apps must opt in explicitly.
 */
export default class RowScopePgDriver implements IsolationDriver {
  readonly name: IsolationDriverName = 'rowscope-pg'
  readonly #centralConnectionName: string
  readonly #scopedTables: string[]
  readonly #scopeColumn: string

  constructor(opts: {
    centralConnectionName?: string
    scopedTables?: string[]
    scopeColumn?: string
  } = {}) {
    this.#centralConnectionName = opts.centralConnectionName ?? 'tenant'
    this.#scopedTables = [...(opts.scopedTables ?? [])]
    this.#scopeColumn = opts.scopeColumn ?? 'tenant_id'
    // Validate config-time inputs once at construction so a typo blows up
    // at boot, not at the first DELETE under load. Each table can be a
    // bare identifier or schema-qualified (`schema.table`).
    for (const table of this.#scopedTables) {
      for (const part of table.split('.')) {
        assertSafeIdentifier(part, `rowScopeTables entry "${table}"`)
      }
    }
    assertSafeIdentifier(this.#scopeColumn, 'rowScopeColumn')
  }

  connectionName(_tenantId: string): string {
    // All tenants share the same physical connection.
    return this.#centralConnectionName
  }

  async provision(_tenant: TenantModelContract): Promise<void> {
    // No-op: storage is shared, central migrations create the tables.
  }

  async destroy(tenant: TenantModelContract, opts: DestroyOptions = {}): Promise<void> {
    if (opts.keepData) return
    if (this.#scopedTables.length === 0) return
    // Defense in depth: even though tenant.id will be passed as a parameter
    // (Lucid binds it), reject obviously malformed ids so they never reach
    // the database in any context (logs, hooks, etc.).
    assertSafeIdentifier(tenant.id, 'tenant id')
    const { db } = await lucid()
    const client = db.connection(this.#centralConnectionName)
    for (const table of this.#scopedTables) {
      await client.from(table).where(this.#scopeColumn, tenant.id).delete()
    }
  }

  async reset(tenant: TenantModelContract): Promise<void> {
    // Reset == destroy under row-scoping. There's nothing to "recreate"
    // because tables live in the shared schema.
    await this.destroy(tenant)
  }

  async connect(_tenant: TenantModelContract) {
    const { db } = await lucid()
    return db.connection(this.#centralConnectionName)
  }

  async disconnect(_tenant: TenantModelContract): Promise<void> {
    // The central connection is shared and managed elsewhere; never close
    // it on a per-tenant disconnect.
  }

  async migrate(
    _tenant: TenantModelContract,
    _opts: MigrateOptions
  ): Promise<MigrateResult> {
    // Migrations are central under row-scoping. Apps run them once via
    // their normal `node ace migration:run`.
    return { executed: 0, noop: true }
  }

  /**
   * Read the scoped column name (used by `withTenantScope` so the mixin
   * matches the driver's column convention).
   */
  get scopeColumn(): string {
    return this.#scopeColumn
  }
}

/**
 * Convenience: read the configured row-scope column from the global
 * multitenancy config without having to resolve the driver instance.
 * Used by `withTenantScope` when the mixin is loaded before the driver.
 */
export function configuredScopeColumn(): string {
  return getConfig().isolation?.rowScopeColumn ?? 'tenant_id'
}
