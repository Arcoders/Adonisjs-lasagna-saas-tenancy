import type { QueryClientContract } from '@adonisjs/lucid/types/database'
import type { MigratorOptions } from '@adonisjs/lucid/types/migrator'
import type { TenantModelContract } from '../../types/contracts.js'

/**
 * The four shipped driver names, plus any custom name a host registers via
 * `IsolationDriverRegistry.register()` (the registry keys drivers by
 * `driver.name` at runtime, so the type must not close the set — see the
 * custom-isolation-driver cookbook). `(string & {})` keeps editor
 * autocomplete for the built-ins while admitting custom names.
 */
export type IsolationDriverName =
  | 'schema-pg'
  | 'database-pg'
  | 'rowscope-pg'
  | 'sqlite-memory'
  | (string & {})

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
 * The isolation-driver contract version: the shape of {@link IsolationDriver}
 * and {@link ProvisionableDriver}. A custom driver declares the version it was
 * built against via `contractVersion`; {@link IsolationDriverRegistry} compares
 * it to this constant so a driver compiled for a newer core fails loudly at
 * registration instead of calling methods the running core does not provide.
 * Bump as a MAJOR for a backward-incompatible change. INDEPENDENT of the
 * satellite ABI and the published version.
 */
export const ISOLATION_CONTRACT_VERSION = 1

/**
 * The core contract every isolation strategy must satisfy. A driver encapsulates
 * the answer to: "where does this tenant's data live, how do I get a Lucid
 * client to it, and how is the tenant boundary enforced on that client?".
 *
 * Storage *creation* is deliberately NOT here — a driver that shares one set of
 * tables across tenants (rowscope-pg) owns no per-tenant storage to provision,
 * and must not be forced to ship a `provision()` no-op that lies. That capability
 * lives on {@link ProvisionableDriver}; use {@link isProvisionableDriver} to
 * branch on it.
 *
 * Shipped drivers:
 *   - `schema-pg`     — one PostgreSQL schema per tenant (default, provisionable)
 *   - `database-pg`   — one PostgreSQL database per tenant (provisionable)
 *   - `rowscope-pg`   — shared schema, `tenant_id` column, scoping via the
 *                       `withTenantScope()` mixin (NOT provisionable)
 *   - `sqlite-memory` — in-memory per-tenant SQLite for tests (provisionable)
 */
export interface IsolationDriver {
  readonly name: IsolationDriverName

  /**
   * Contract version this driver was built against (see
   * {@link ISOLATION_CONTRACT_VERSION}). Omitted on legacy drivers — the
   * registry warns rather than fails when it is absent.
   */
  readonly contractVersion?: number

  /**
   * Apply this driver's tenant boundary to a client the adapter just resolved
   * for `tenantId`, called synchronously on every model-query routing. For
   * connection-isolated drivers (schema-pg, database-pg, sqlite-memory) the
   * connection *is* the boundary, so this is a documented no-op. Row-scoping
   * drivers enforce the boundary at query time (the `withTenantScope()` mixin)
   * and, optionally, per transaction via `withTenantRls()`, so there is nothing
   * to stamp synchronously here either — but every driver declares the hook so
   * the responsibility is explicit in the contract and a custom driver cannot
   * forget it.
   */
  enforce(client: QueryClientContract, tenantId: string): void

  /**
   * Destroy the tenant's data. By default removes it; pass `{ keepData: true }`
   * for the recycle-bin pattern. Every driver can tear a tenant down —
   * schema-pg drops the schema, rowscope-pg deletes the scoped rows — so this
   * stays on the core contract.
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
   *
   * `bypassHardCap` skips the opt-in connection-cap admission check — operational
   * paths (provisioning, migrations, seeding) must not be refused by request-path
   * backpressure. Drivers without a per-tenant pool ignore it.
   */
  connect(
    tenant: TenantModelContract,
    opts?: { bypassHardCap?: boolean }
  ): Promise<QueryClientContract>

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
   * Synchronously mark this tenant's connection as just-used, refreshing the
   * in-use grace window so a long-running request isn't evicted mid-flight.
   * Called by `TenantAdapter` on every model-query routing. Optional: drivers
   * without a per-tenant connection pool (rowscope-pg) don't implement it.
   */
  markUsed?(tenantId: string): void

  /**
   * Run migrations against the tenant's storage. For drivers without
   * per-tenant storage (rowscope-pg) this returns `{ executed: 0,
   * noop: true }` — central migrations are the canonical source.
   */
  migrate(tenant: TenantModelContract, opts: MigrateOptions): Promise<MigrateResult>
}

/**
 * An isolation driver that owns per-tenant storage and can create it. Only
 * drivers that provision real storage (schema-pg, database-pg, sqlite-memory)
 * implement this; rowscope-pg shares the central tables and is a plain
 * {@link IsolationDriver}. Callers that need to provision a tenant must narrow
 * with {@link isProvisionableDriver} first.
 */
export interface ProvisionableDriver extends IsolationDriver {
  /**
   * Provision the underlying storage for a brand-new tenant. Idempotent:
   * a second call on an already-provisioned tenant must not throw.
   */
  provision(tenant: TenantModelContract): Promise<void>
}

/**
 * Narrow an {@link IsolationDriver} to a {@link ProvisionableDriver}. True when
 * the driver owns per-tenant storage it can create (it implements `provision`);
 * false for shared-storage drivers like rowscope-pg.
 */
export function isProvisionableDriver(
  driver: IsolationDriver | null | undefined
): driver is ProvisionableDriver {
  return typeof (driver as ProvisionableDriver | null | undefined)?.provision === 'function'
}

export interface ResetOptions {
  /** Skip the `provision` step after dropping. Default: false. */
  dropOnly?: boolean
}
