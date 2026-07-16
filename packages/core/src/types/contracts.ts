import type { QueryClientContract } from '@adonisjs/lucid/types/database'
import type { DateTime } from 'luxon'

/**
 * Container binding key for the host's `TenantRepositoryContract`
 * implementation. Uses `Symbol.for(...)` (registry-keyed) so any
 * second evaluation of this module resolves to the same symbol.
 *
 * Why this matters: when integration tests run under `tsx`, the
 * loader can pull `src/types/contracts.ts` (TS source) for one
 * import path while the package's own `build/` runtime has already
 * loaded `build/src/types/contracts.js` for another. With a plain
 * `Symbol(...)` the two evaluations produce distinct symbols and
 * `container.make(TENANT_REPOSITORY)` throws "Cannot resolve
 * binding "Symbol(TENANT_REPOSITORY)" from the container". The
 * registry key is namespaced so it doesn't collide with anything
 * else on `globalThis`.
 */
export const TENANT_REPOSITORY = Symbol.for('@adonisjs-lasagna/saas-tenancy/TENANT_REPOSITORY')

export type TenantStatus = 'provisioning' | 'active' | 'suspended' | 'failed' | 'deleted'

/**
 * Default shape of the optional `metadata` field on a tenant model. Apps
 * can pass a stricter type via the `TMeta` generic to get end-to-end
 * type safety, e.g. `TenantModelContract<{ plan: 'free' | 'pro' }>`.
 */
export type TenantMetadata = Record<string, unknown>

/**
 * Contract every tenant model implementation must satisfy.
 *
 * v2 dropped `getConnection`/`closeConnection`/`install`/`uninstall`/
 * `migrate`/`dropSchemaIfExists`/`invalidateCache` from this contract.
 * Those concerns now live on `IsolationDriver`. Implementations can keep
 * those methods around for their own use, but the package never calls
 * them.
 */
export interface TenantModelContract<TMeta extends object = TenantMetadata> {
  readonly id: string
  name: string
  email: string
  status: TenantStatus
  customDomain: string | null
  createdAt: DateTime
  deletedAt: DateTime | null
  /** Optional structured metadata. Type via the `TMeta` generic. */
  metadata?: TMeta
  readonly schemaName: string
  readonly isActive: boolean
  readonly isSuspended: boolean
  readonly isProvisioning: boolean
  readonly isFailed: boolean
  readonly isDeleted: boolean
  /**
   * Maintenance mode is independent of `status`. A tenant can be `active`
   * AND in maintenance, useful for scheduled migrations, billing
   * cutovers, etc., without flipping the lifecycle status.
   *
   * Implementations that don't expose this column should default
   * `isMaintenance` to `false` and treat `enterMaintenance/exitMaintenance`
   * as a no-op so older models keep working.
   */
  readonly isMaintenance?: boolean
  maintenanceMessage?: string | null
  enterMaintenance?(message?: string | null): Promise<void>
  exitMaintenance?(): Promise<void>
  /**
   * Optional: when implemented, returns a Lucid client routed to a read
   * replica. Apps typically wire this up via `ReadReplicaService.resolve(this)`.
   * Without read replicas configured, callers should fall back to the
   * primary client returned by the active isolation driver.
   */
  getReadConnection?(): QueryClientContract | Promise<QueryClientContract>
  suspend(): Promise<void>
  activate(): Promise<void>
  save(): Promise<TenantModelContract<TMeta>>
}

export interface EachOptions {
  /** Page size for the cursor. Default: 100. */
  batchSize?: number | undefined
  /** Filter by status. Defaults to all statuses. */
  statuses?: TenantStatus[] | undefined
  /** Include soft-deleted tenants. Default: false. */
  includeDeleted?: boolean | undefined
}

export interface TenantRepositoryContract<TMeta extends object = TenantMetadata> {
  findById(id: string, includeDeleted?: boolean): Promise<TenantModelContract<TMeta> | null>
  findByIdOrFail(id: string, includeDeleted?: boolean): Promise<TenantModelContract<TMeta>>
  findByDomain(domain: string): Promise<TenantModelContract<TMeta> | null>
  all(options?: {
    includeDeleted?: boolean
    statuses?: TenantStatus[]
  }): Promise<TenantModelContract<TMeta>[]>
  /**
   * Optional aggregate: counts of tenants grouped by status, computed in the
   * database (`GROUP BY status`) WITHOUT hydrating any rows.
   *
   * When implemented, ops paths that only need counts (notably the `/metrics`
   * collector) use this instead of `all()`, turning an O(n-tenants) full-table
   * load on every Prometheus scrape into a single O(1) aggregate. Implementations
   * that omit it keep working: callers fall back to `all()` and count in memory.
   *
   * Returns a partial map (a status absent from the result counts as 0). Include
   * soft-deleted tenants when `includeDeleted` is true.
   */
  countByStatus?(options?: {
    includeDeleted?: boolean
  }): Promise<Partial<Record<TenantStatus, number>>>
  whereIn(ids: string[], includeDeleted?: boolean): Promise<TenantModelContract<TMeta>[]>
  /**
   * Iterate over tenants in cursor-paginated batches (keyset on the primary
   * key, not OFFSET). Memory-safe for large tenant counts and stable under
   * mutation: a callback that creates, deletes or status-changes tenants
   * mid-iteration cannot shift the cursor, so every row that still matches
   * the filters when its batch is fetched is visited exactly once. The
   * callback runs sequentially per tenant; throw inside it to abort
   * iteration.
   */
  each(
    callback: (tenant: TenantModelContract<TMeta>) => Promise<void> | void,
    options?: EachOptions
  ): Promise<void>
  create(data: {
    name: string
    email: string
    status: TenantStatus
  }): Promise<TenantModelContract<TMeta>>
}

declare module '@adonisjs/core/types' {
  interface ContainerBindings {
    [TENANT_REPOSITORY]: TenantRepositoryContract
  }
}
