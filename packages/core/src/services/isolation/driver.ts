import type { QueryClientContract } from '@adonisjs/lucid/types/database'
import type { MigratorOptions } from '@adonisjs/lucid/types/migrator'
import type { TenantModelContract } from '../../types/contracts.js'

/**
 * The four shipped driver names, plus any custom name a host registers via
 * `IsolationDriverRegistry.register()` (the registry keys drivers by
 * `driver.name` at runtime, so the type must not close the set; see the
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
export type MigrateOptions = Omit<MigratorOptions, 'connectionName'> & {
  /**
   * Additional per-tenant migration source directories to fold into this run,
   * on top of the connection's own configured `migrations.paths`. Reserved for
   * the per-tenant satellite-migration wiring: a satellite registers
   * its per-tenant migration directory and `tenant:migrate` threads it here.
   * The shipped drivers do not consume it yet; it is declared on the contract
   * now, riding the v2 bump, so that wiring can land later without a second
   * breaking change against a moving shape.
   */
  extraMigrationPaths?: string[]
}
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
 *
 * v2 (current): added the required {@link IsolationDriver.tableLocation} method
 * and the optional {@link MigrateOptions.extraMigrationPaths} field. Because a
 * required member was added, {@link IsolationDriverRegistry.register} pairs this
 * bump with an unconditional presence check that throws for any driver missing
 * `tableLocation()` (a bare version bump would only warn for a v1/unversioned
 * driver and let it register, then crash at first call).
 */
export const ISOLATION_CONTRACT_VERSION = 2

/**
 * Where a tenant's per-tenant tables physically live, as a closed discriminated
 * union on `kind`. A satellite that stores per-tenant rows (embeddings, memory,
 * metering) asks the active driver via {@link IsolationDriver.tableLocation} and
 * switches on `kind` with a `never`-exhaustive default, so it never hardcodes a
 * `tenant_<id>` namespace and never branches on the concrete driver class. The
 * union is a plain value (every field `readonly`); there is no `null`/`none`
 * variant, so a caller never has to null-check a placement.
 *
 * Every namespace string a variant carries (`schema`, `database`, `scopeColumn`)
 * has already passed `assertSafeIdentifier`, so it is safe to interpolate into
 * DDL.
 */
export type TableLocation =
  | TableLocationSchema
  | TableLocationDatabase
  | TableLocationRowscope
  | TableLocationConnection

/** schema-per-tenant (schema-pg): the tenant owns a dedicated PostgreSQL schema. */
export interface TableLocationSchema {
  readonly kind: 'schema'
  /** The tenant's dedicated schema, e.g. `tenant_<id>`. `assertSafeIdentifier`-checked. */
  readonly schema: string
  /** The Lucid connection routed to that schema (equals `connectionName(tenant.id)`). */
  readonly connectionName: string
}

/** database-per-tenant (database-pg): the tenant owns a dedicated PostgreSQL database. */
export interface TableLocationDatabase {
  readonly kind: 'database'
  /** The tenant's dedicated database, e.g. `tenant_<id>`. `assertSafeIdentifier`-checked. */
  readonly database: string
  /** The Lucid connection routed to that database (equals `connectionName(tenant.id)`). */
  readonly connectionName: string
}

/**
 * shared schema + `tenant_id` predicate + RLS (rowscope-pg): the tenant has NO
 * per-tenant namespace. Placement is the shared connection plus the scope column
 * plus the RLS predicate metadata, never a schema/database to qualify.
 */
export interface TableLocationRowscope {
  readonly kind: 'rowscope'
  /**
   * The tenant-discriminator column (config `rowScopeColumn`, default
   * `tenant_id`). `assertSafeIdentifier`-checked.
   */
  readonly scopeColumn: string
  /**
   * Whether row-level security backstops the scope column. Reflects
   * `isolation.rowScopeRls`, which the provider BOOT-VERIFIES against the RLS
   * catalog when `true` (it refuses to start unless every scoped table has RLS
   * enabled, forced, policied, and a NOT NULL scope column). This accessor does
   * no IO; it reports that boot-verified configured intent.
   */
  readonly rls: boolean
  /**
   * The per-transaction setting the RLS policy reads (`DEFAULT_RLS_GUC`).
   * Present if and only if `rls` is `true`.
   */
  readonly rlsGuc?: string
  /** The shared/central Lucid connection every tenant uses (equals `connectionName(tenant.id)`). */
  readonly connectionName: string
}

/**
 * connection-IS-the-namespace (sqlite-memory test driver): no real schema or
 * database, so the per-tenant connection wholly defines placement.
 */
export interface TableLocationConnection {
  readonly kind: 'connection'
  /** The per-tenant connection that is itself the namespace (equals `connectionName(tenant.id)`). */
  readonly connectionName: string
}

/**
 * The core contract every isolation strategy must satisfy. A driver encapsulates
 * the answer to: "where does this tenant's data live, how do I get a Lucid
 * client to it, and how is the tenant boundary enforced on that client?".
 *
 * Storage *creation* is deliberately NOT here. A driver that shares one set of
 * tables across tenants (rowscope-pg) owns no per-tenant storage to provision,
 * and must not be forced to ship a `provision()` no-op that lies. That capability
 * lives on {@link ProvisionableDriver}; use {@link isProvisionableDriver} to
 * branch on it.
 *
 * Shipped drivers:
 *   - `schema-pg`: one PostgreSQL schema per tenant (default, provisionable)
 *   - `database-pg`: one PostgreSQL database per tenant (provisionable)
 *   - `rowscope-pg`: shared schema, `tenant_id` column, scoping via the
 *     `withTenantScope()` mixin (NOT provisionable)
 *   - `sqlite-memory`: in-memory per-tenant SQLite for tests (provisionable)
 */
export interface IsolationDriver {
  readonly name: IsolationDriverName

  /**
   * Contract version this driver was built against (see
   * {@link ISOLATION_CONTRACT_VERSION}). Omitted on legacy drivers, where the
   * registry warns rather than fails when it is absent.
   */
  readonly contractVersion?: number

  /**
   * OPTIONAL hook: stamp something on a client the adapter just resolved for
   * `tenantId`, called synchronously on every model-query routing. This is NOT
   * how the shipped drivers enforce their tenant boundary, so none of them
   * implement it:
   *   - connection-isolated drivers (schema-pg, database-pg, sqlite-memory) —
   *     the per-tenant connection *is* the boundary; there is nothing to stamp.
   *   - row-scoping (rowscope-pg) — the boundary is applied at query time by the
   *     `withTenantScope()` mixin and, when a hard boundary is required, per
   *     transaction via `withTenantRls()`; nothing is stamped synchronously.
   *
   * It exists only as an escape hatch for a custom driver that genuinely needs a
   * synchronous per-query touch on the client (an unusual design). Because the
   * adapter calls it as `driver.enforce?.(client, tenantId)`, omitting it is the
   * norm, not a gap.
   */
  enforce?(client: QueryClientContract, tenantId: string): void

  /**
   * Destroy the tenant's data. By default removes it; pass `{ keepData: true }`
   * for the recycle-bin pattern. Every driver can tear a tenant down (schema-pg
   * drops the schema, rowscope-pg deletes the scoped rows), so this
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
   * `bypassHardCap` skips the opt-in connection-cap admission check: operational
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
   * Resolve WHERE this tenant's per-tenant tables physically live, as a
   * driver-agnostic {@link TableLocation} tagged union, so a satellite places
   * its own per-tenant tables (e.g. AI embeddings/memory) with zero
   * `tenant_<id>` hardcoding and zero branching on the concrete driver. Pure
   * and synchronous: it derives placement from config plus the tenant id only
   * (no Lucid, no IO), mirroring `connectionName()` / `schemaName()` /
   * `databaseName()`. Fails closed on a malformed tenant id (throws via
   * `assertSafeIdentifier`), so a caller can never receive an injectable
   * namespace.
   */
  tableLocation(tenant: TenantModelContract): TableLocation

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
   * noop: true }`, since central migrations are the canonical source.
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
