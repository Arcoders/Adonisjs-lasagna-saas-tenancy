export { default as BackupService } from './services/backup_service.js'
export type { BackupMetadata } from './services/backup_service.js'
export { default as BackupRetentionService } from './services/backup_retention_service.js'
export type { RetentionPlan } from './services/backup_retention_service.js'
export { default as CloneService } from './services/clone_service.js'
export type { CloneOptions, CloneResult } from './services/clone_service.js'
export {
  default as SqlImportService,
  PsqlNotAvailableError,
} from './services/sql_import_service.js'
export type { SqlImportOptions, SqlImportResult } from './services/sql_import_service.js'

// Per-tenant mutual exclusion for backup-family operations. Exported so a host
// app (or an admin API layer) can reuse the lock or catch the typed exception.
export {
  withTenantOperationLock,
  TenantOperationLockedException,
  TenantOperationLockUnavailableException,
  tenantOperationLockKey,
} from './services/tenant_operation_lock.js'
export type { TenantOperationLockOptions } from './services/tenant_operation_lock.js'

export { default as BackupTenant } from './jobs/backup_tenant.js'
export { default as RestoreTenant } from './jobs/restore_tenant.js'
export { default as CloneTenant } from './jobs/clone_tenant.js'
export type { CloneTenantPayload } from './jobs/clone_tenant.js'

// Doctor check (registered into the core DoctorService by the provider)
export { default as backupRecencyCheck } from './doctor/backup_recency_check.js'

// Config authoring surface (mirrors the reporting satellite).
export { defineBackupConfig } from './define_config.js'
export type { MultitenancyConfigWithBackup, BackupConfig } from './define_config.js'
