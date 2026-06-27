export { resolveTenantRepository } from './resolve_tenant_repository.js'
export { mapTenants } from './map_tenants.js'
export type { MapTenantsOptions, MapTenantsResult } from './map_tenants.js'
export { mapDataAsOf, isStale, staleDays } from '../freshness.js'
export { default as CircuitBreakerService } from './circuit_breaker_service.js'
export type { CircuitState, CircuitMetrics } from './circuit_breaker_service.js'
export { default as TenantQueueService } from './tenant_queue_service.js'
export type { TenantQueueStats } from './tenant_queue_service.js'
export { default as TelemetryService } from './telemetry_service.js'
export { default as ResilienceService } from './resilience_service.js'
export type { ResilienceRunOptions } from './resilience_service.js'
export type { FailurePolicy, ResilienceConfig } from '../types/config.js'
// `BackupService`, `BackupRetentionService`, `CloneService`, `SqlImportService`
// moved to `@adonisjs-lasagna/backup`. Their shared result types
// (`BackupMetadata`, `CloneResult`) live in `@adonisjs-lasagna/saas-tenancy/types`.
export { default as AuditLogService } from './audit_log_service.js'
export type { LogOptions, LogActionOptions } from './audit_log_service.js'
export {
  default as AuditLogDestinationRegistry,
  AUDIT_CONTRACT_VERSION,
} from './audit_log_destination_registry.js'
export type { AuditLogDestination, AuditLogEntry } from './audit_log_destination_registry.js'
export { default as CrossDomainRedirectService } from './cross_domain_redirect_service.js'
export type { BuildUrlOptions } from './cross_domain_redirect_service.js'
export { default as ImpersonationService } from './impersonation_service.js'
export { default as FeatureFlagService } from './feature_flag_service.js'
export type { FeatureFlagRecord } from './feature_flag_service.js'
export {
  default as EvaluationStrategyRegistry,
  DEFAULT_EVALUATION_STRATEGY,
  FEATURE_FLAGS_CONTRACT_VERSION,
} from './evaluation_strategy_registry.js'
export type {
  EvaluationStrategy,
  FeatureFlagEvaluationContext,
} from './evaluation_strategy_registry.js'
export { default as WebhookService, verifyWebhookSignature } from './webhook_service.js'
export type { RegisterWebhookResult } from './webhook_service.js'
export {
  default as WebhookTransformerRegistry,
  WEBHOOKS_CONTRACT_VERSION,
} from './webhook_transformer_registry.js'
export type { WebhookPayloadTransformer } from './webhook_transformer_registry.js'
// Expose the shared BentoCache instance so apps that namespace their
// own cache keys (and integration tests that need to seed sessions
// directly) don't have to dig into internal paths. `cacheFor(tenant)`
// is the safer default — it returns a namespace already prefixed with
// the tenant id so cross-tenant key collisions are impossible.
// `buildCacheStack` is the same factory the singleton runs through —
// exported so tests and hosts needing an isolated instance exercise the
// real wiring instead of copying it.
export { getCache, cacheFor, buildCacheStack } from '../utils/cache.js'
export type { CacheStackOptions } from '../utils/cache.js'
export { default as BrandingService } from './branding_service.js'
export type { BrandingData } from './branding_service.js'
// `SsoService` moved to `@adonisjs-lasagna/sso`.
export { default as MetricsService } from './metrics_service.js'
export { default as QuotaService } from './quota_service.js'
export type { QuotaCheckResult, QuotaStateSnapshot, QuotaMode } from './quota_service.js'
// `BillingService` + `redactStripeEvent` moved to `@adonisjs-lasagna/billing`.
export { default as ReadReplicaService } from './read_replica_service.js'
// Shared extension-execution primitives: `consumeRateLimit` is the sliding-window
// counter the rate-limit middleware also uses; `executeExtension` wraps
// host-supplied extension code in optional timeout + rate-limit guards. See the
// satellite extensibility standard (docs/satellites/extensibility).
export { consumeRateLimit } from './rate_limiter.js'
export type { ConsumeRateLimitArgs, RateLimitReading } from './rate_limiter.js'
export { executeExtension, ExtensionTimeoutError } from './extensions/execute_extension.js'
export type { ExecuteExtensionOptions } from './extensions/execute_extension.js'
export {
  default as TenantResolutionCache,
  DEFAULT_RESOLUTION_CACHE_TTL_MS,
  DEFAULT_RESOLUTION_CACHE_MAX,
} from './tenant_resolution_cache.js'
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
  setTenantRlsGuc,
  withTenantRls,
  DEFAULT_RLS_GUC,
  ISOLATION_CONTRACT_VERSION,
  isProvisionableDriver,
} from './isolation/index.js'
// Custom isolation drivers interpolate tenant ids into DDL/paths and must
// validate them the same way the shipped drivers do (see the
// custom-isolation-driver cookbook), so the validator is part of this
// surface. Also available via the `/internal` subpath.
export { assertSafeIdentifier, isUuidV4 } from './isolation/identifier.js'
export {
  TenantResolverRegistry,
  HeaderResolver,
  SubdomainResolver,
  PathResolver,
  DomainOrSubdomainResolver,
  RequestDataResolver,
  ResolverHit,
  RESOLVER_CONTRACT_VERSION,
  builtInResolvers,
} from './resolvers/index.js'
export type { TenantResolver, TenantResolveResult } from './resolvers/index.js'
export type {
  IsolationDriver,
  ProvisionableDriver,
  IsolationDriverName,
  DestroyOptions,
  MigrateOptions,
  MigrateResult,
  RlsQueryRunner,
  RlsTransactor,
  SetTenantRlsGucOptions,
  WithTenantRlsOptions,
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
  provisioningStalledCheck,
  failedTenantsCheck,
  connectionPoolCheck,
  membershipGateCheck,
  metricsFreshnessCheck,
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
export {
  ComplianceReportService,
  builtInControls,
  auditImmutabilityControl,
  secretEncryptionControl,
  tenantIsolationControl,
  accessAuthorizationControl,
  dataRetentionControl,
} from './compliance/index.js'
export type {
  ControlStatus,
  ComplianceContext,
  ControlDetection,
  ComplianceControl,
  ControlResult,
  ComplianceReport,
  ComplianceRunOptions,
} from './compliance/index.js'
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
