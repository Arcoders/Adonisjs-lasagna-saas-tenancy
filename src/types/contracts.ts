import type { QueryClientContract } from '@adonisjs/lucid/types/database'
import type { DateTime } from 'luxon'

export const TENANT_REPOSITORY = Symbol('TENANT_REPOSITORY')

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
 * `migrate`/`dropSchemaIfExists`/`invalidateCache` from this contract —
 * those concerns now live on `IsolationDriver`. Implementations can keep
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
   * AND in maintenance — useful for scheduled migrations, billing
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
  batchSize?: number
  /** Filter by status. Defaults to all statuses. */
  statuses?: TenantStatus[]
  /** Include soft-deleted tenants. Default: false. */
  includeDeleted?: boolean
}

export interface TenantRepositoryContract<TMeta extends object = TenantMetadata> {
  findById(id: string, includeDeleted?: boolean): Promise<TenantModelContract<TMeta> | null>
  findByIdOrFail(id: string, includeDeleted?: boolean): Promise<TenantModelContract<TMeta>>
  findByDomain(domain: string): Promise<TenantModelContract<TMeta> | null>
  all(options?: {
    includeDeleted?: boolean
    statuses?: TenantStatus[]
  }): Promise<TenantModelContract<TMeta>[]>
  whereIn(ids: string[], includeDeleted?: boolean): Promise<TenantModelContract<TMeta>[]>
  /**
   * Iterate over tenants in cursor-paginated batches. Memory-safe for large
   * tenant counts. The callback runs sequentially per tenant; throw inside it
   * to abort iteration.
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
