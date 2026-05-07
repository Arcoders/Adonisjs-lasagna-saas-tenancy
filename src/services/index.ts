export { default as CircuitBreakerService } from './circuit_breaker_service.js'
export type { CircuitState, CircuitMetrics } from './circuit_breaker_service.js'
export { default as TenantQueueService } from './tenant_queue_service.js'
export type { TenantQueueStats } from './tenant_queue_service.js'
export { default as TelemetryService } from './telemetry_service.js'
export { default as BackupService } from './backup_service.js'
export type { BackupMetadata } from './backup_service.js'
export { default as BackupRetentionService } from './backup_retention_service.js'
export type { RetentionPlan } from './backup_retention_service.js'
export { default as CloneService } from './clone_service.js'
export type { CloneOptions, CloneResult } from './clone_service.js'
export { default as SqlImportService } from './sql_import_service.js'
export type { SqlImportOptions, SqlImportResult } from './sql_import_service.js'
export { default as AuditLogService } from './audit_log_service.js'
export type { LogActionOptions } from './audit_log_service.js'
export { default as CrossDomainRedirectService } from './cross_domain_redirect_service.js'
export type { BuildUrlOptions } from './cross_domain_redirect_service.js'
export { default as ImpersonationService } from './impersonation_service.js'
export { default as FeatureFlagService } from './feature_flag_service.js'
export { default as WebhookService, verifyWebhookSignature } from './webhook_service.js'
// Expose the shared BentoCache instance so apps that namespace their
// own cache keys (and integration tests that need to seed sessions
// directly) don't have to dig into internal paths. `cacheFor(tenant)`
// is the safer default — it returns a namespace already prefixed with
// the tenant id so cross-tenant key collisions are impossible.
export { getCache, cacheFor } from '../utils/cache.js'
export { default as BrandingService } from './branding_service.js'
export type { BrandingData } from './branding_service.js'
export { default as SsoService } from './sso_service.js'
export { default as MetricsService } from './metrics_service.js'
export { default as QuotaService } from './quota_service.js'
export type { QuotaCheckResult, QuotaStateSnapshot, QuotaMode } from './quota_service.js'
export { default as ReadReplicaService } from './read_replica_service.js'
export { default as HookRegistry } from './hook_registry.js'
export { default as BootstrapperRegistry } from './bootstrapper_registry.js'
export type { BootstrapperContext, TenantBootstrapper } from './bootstrapper_registry.js'
export {
  IsolationDriverRegistry,
  SchemaPgDriver,
  DatabasePgDriver,
  RowScopePgDriver,
  SqliteMemoryDriver,
  configuredScopeColumn,
  getActiveDriver,
} from './isolation/index.js'
export {
  TenantResolverRegistry,
  HeaderResolver,
  SubdomainResolver,
  PathResolver,
  DomainOrSubdomainResolver,
  RequestDataResolver,
  ResolverHit,
  builtInResolvers,
} from './resolvers/index.js'
export type { TenantResolver, TenantResolveResult } from './resolvers/index.js'
export type {
  IsolationDriver,
  IsolationDriverName,
  DestroyOptions,
  MigrateOptions,
  MigrateResult,
} from './isolation/index.js'
export {
  cacheBootstrapper,
  createCacheBootstrapper,
  tenantCache,
  CACHE_NAMESPACE_PREFIX,
  driveBootstrapper,
  createDriveBootstrapper,
  tenantDisk,
  tenantPrefix,
  TENANT_DRIVE_PREFIX,
  mailBootstrapper,
  createMailBootstrapper,
  tenantMailer,
  TENANT_MAIL_HEADER,
  sessionBootstrapper,
  createSessionBootstrapper,
  tenantSession,
  tenantSessionKey,
  TENANT_SESSION_PREFIX,
  transmitBootstrapper,
  createTransmitBootstrapper,
  tenantBroadcast,
  tenantChannel,
  TENANT_BROADCAST_PREFIX,
} from './bootstrappers/index.js'
export type { TransmitBootstrapperOptions } from './bootstrappers/index.js'
export {
  DoctorService,
  builtInChecks,
  longRunningQueriesCheck,
  replicaLagCheck,
  queueStuckCheck,
  schemaDriftCheck,
  migrationStateCheck,
  circuitBreakerCheck,
  backupRecencyCheck,
  provisioningStalledCheck,
  failedTenantsCheck,
  connectionPoolCheck,
} from './doctor/index.js'
export type {
  DiagnosisSeverity,
  DiagnosisIssue,
  DiagnosisReport,
  DoctorCheck,
  DoctorContext,
  DoctorRunOptions,
  DoctorRunResult,
} from './doctor/index.js'
export { default as TenantLogContext } from './tenant_log_context.js'
export type { TenantLogContextData } from './tenant_log_context.js'
export { tenantLogger } from './tenant_logger.js'
export type {
  TenantLifecyclePhase,
  TenantLifecycleEvent,
  TenantLifecycleHook,
  TenantHookContext,
  TenantBackupHookContext,
  TenantRestoreHookContext,
  TenantCloneHookContext,
  TenantMigrateHookContext,
  HookContextByEvent,
  DeclarativeHooks,
} from './hook_registry.js'
