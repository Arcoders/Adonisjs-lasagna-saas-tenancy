import type { TenantModelContract } from './contracts.js'

/**
 * Shape of a single backup archive's metadata. Defined in the core (not in
 * `@adonisjs-lasagna/backup`) because the core's hook contract
 * (`TenantBackupHookContext`) and the `TenantBackedUp` lifecycle event carry
 * it, and the core never imports a satellite package. The backup package's
 * `BackupService` imports and re-exports this type, so there is one definition.
 */
export interface BackupMetadata {
  file: string
  size: number
  timestamp: string
  tenantId: string
  schema: string
}

/**
 * Result of cloning one tenant's schema into another. Lives in the core for the
 * same reason as {@link BackupMetadata}: `TenantCloneHookContext` and the
 * `TenantCloned` lifecycle event reference it. `CloneService` (in
 * `@adonisjs-lasagna/backup`) imports and re-exports it.
 */
export interface CloneResult {
  source: TenantModelContract
  destination: TenantModelContract
  tablesCopied: number
  rowsCopied: number
}
