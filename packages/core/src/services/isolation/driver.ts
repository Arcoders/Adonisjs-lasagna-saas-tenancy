import type { QueryClientContract } from '@adonisjs/lucid/types/database'
import type { MigratorOptions } from '@adonisjs/lucid/types/migrator'
import type { TenantModelContract } from '../../types/contracts.js'

export type IsolationDriverName = 'schema-pg' | 'database-pg' | 'rowscope-pg' | 'sqlite-memory'

export interface DestroyOptions {
  /**
   * If true, the underlying storage (schema/database) is left intact and
   * only the tenant's logical record is marked for soft-deletion. Used by
   * the recycle-bin pattern in `tenant:destroy --keep-schema`.
   */
  keepData?: boolean
}

/**
 * `up` runs pending migrations; `down` rolls back the last batch. Drivers
 * that don't actually own a connection (rowscope-pg) treat both as
 * no-ops and rely on the central migrations.
 */
export type MigrateOptions = Omit<MigratorOptions, 'connectionName'>
export type MigrateDirection = 'up' | 'down'

export interface MigrateResult {
  /** Number of migration files executed in this run. */
  executed: number
  /** True if the driver does not own per-tenant migrations. */
  noop?: boolean
}

/**
 * The contract every isolation strategy must satisfy. A driver encapsulates
 * the answer to: "where does this tenant's data live, and how do I get a
 * Lucid client to it?".
 *
 * Three production drivers are planned:
 *   - `schema-pg`     — one PostgreSQL schema per tenant (current default)
 *   - `database-pg`   — one PostgreSQL database per tenant
 *   - `rowscope-pg`   — shared schema, `tenant_id` column, scoping via
 *                       `withTenantScope()` mixin
 *
 * Plus `sqlite-memory` for tests.
 */
export interface IsolationDriver {
  readonly name: IsolationDriverName

  /**
   * Provision the underlying storage for a brand-new tenant. Idempotent:
   * a second call on an already-provisioned tenant must not throw.
   */
  provision(tenant: TenantModelContract): Promise<void>

  /**
   * Destroy the tenant's storage. By default removes data; pass
   * `{ keepData: true }` for the recycle-bin pattern.
   */
  destroy(tenant: TenantModelContract, opts?: DestroyOptions): Promise<void>

  /**
   * Drop and re-provision. Used by `tenant:migrate:fresh`. Drivers without
   * dedicated storage (rowscope-pg) implement this as a `DELETE WHERE
   * tenant_id = ?` cascade across registered tables.
   */
  reset(tenant: TenantModelContract): Promise<void>

  /**
   * Return (and lazily register) the Lucid client routed to this tenant's
   * storage. Implementations are expected to memoize within a connection
   * pool so repeated calls within a request reuse the same client.
   */
  connect(tenant: TenantModelContract): Promise<QueryClientContract>

  /**
   * Close and unregister the tenant's connection from the Lucid manager.
   * No-op if the connection isn't currently registered.
   */
  disconnect(tenant: TenantModelContract): Promise<void>

  /**
   * The deterministic Lucid connection name used for this tenant. Takes
   * `tenantId` (not the full model) so synchronous callers like
   * `TenantAdapter` can resolve the name without loading the model.
   */
  connectionName(tenantId: string): string

  /**
   * Run migrations against the tenant's storage. For drivers without
   * per-tenant storage (rowscope-pg) this returns `{ executed: 0,
   * noop: true }` — central migrations are the canonical source.
   */
  migrate(tenant: TenantModelContract, opts: MigrateOptions): Promise<MigrateResult>
}

export interface ResetOptions {
  /** Skip the `provision` step after dropping. Default: false. */
  dropOnly?: boolean
}
