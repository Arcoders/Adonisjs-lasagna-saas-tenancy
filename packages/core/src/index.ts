export type {
  MultitenancyConfig,
  TenantResolverStrategy,
  IsolationConfig,
  IsolationDriverChoice,
  RequestDataResolverConfig,
  RoutingConfig,
} from './types/config.js'
export { TENANT_REPOSITORY } from './types/contracts.js'
export type {
  TenantModelContract,
  TenantRepositoryContract,
  TenantStatus,
  TenantMetadata,
} from './types/contracts.js'
// `BackupMetadata` / `CloneResult` are referenced by the tenant-lifecycle hook
// contexts + the `TenantBackedUp` / `TenantCloned` events, which stay in core.
// The implementing services moved to `@adonisjs-lasagna/backup`.
export type { BackupMetadata, CloneResult } from './types/backup.js'
export { BackofficeBaseModel, TenantBaseModel, CentralBaseModel } from './models/base/index.js'
export { DefaultLucidAdapter, BackofficeAdapter, TenantAdapter } from './models/adapters/index.js'
export {
  TenantAuditLog,
  TenantFeatureFlag,
  TenantWebhook,
  TenantWebhookDelivery,
  TenantBranding,
  TenantMetric,
} from './models/satellites/index.js'
// `TenantSsoConfig` moved to `@adonisjs-lasagna/sso`.
export type { AuditActorType, DeliveryStatus } from './models/satellites/index.js'
export {
  RateLimitMiddleware,
  CustomDomainMiddleware,
  TenantGuardMiddleware,
  CentralOnlyMiddleware,
  UniversalMiddleware,
  ImpersonationMiddleware,
  enforceQuota,
} from './middleware/index.js'
export type { RateLimitOptions, EnforceQuotaOptions } from './middleware/index.js'
export {
  CircuitBreakerService,
  TenantQueueService,
  TelemetryService,
  AuditLogService,
  CrossDomainRedirectService,
  ImpersonationService,
  FeatureFlagService,
  WebhookService,
  BrandingService,
  MetricsService,
  QuotaService,
  ReadReplicaService,
  HookRegistry,
  BootstrapperRegistry,
  IsolationDriverRegistry,
  SchemaPgDriver,
  DatabasePgDriver,
  RowScopePgDriver,
  SqliteMemoryDriver,
  configuredScopeColumn,
  getActiveDriver,
  TenantResolverRegistry,
  HeaderResolver,
  SubdomainResolver,
  PathResolver,
  DomainOrSubdomainResolver,
  RequestDataResolver,
  ResolverHit,
  builtInResolvers,
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
  TenantLogContext,
  tenantLogger,
} from './services/index.js'
export type {
  CircuitState,
  CircuitMetrics,
  TenantQueueStats,
  LogActionOptions,
  BrandingData,
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
  BootstrapperContext,
  TenantBootstrapper,
  IsolationDriver,
  IsolationDriverName,
  DestroyOptions,
  MigrateOptions,
  MigrateResult,
  TenantResolver,
  TenantResolveResult,
  TenantLogContextData,
  QuotaCheckResult,
  QuotaStateSnapshot,
  QuotaMode,
} from './services/index.js'
export {
  TenantCreated,
  TenantActivated,
  TenantSuspended,
  TenantProvisioned,
  TenantDeleted,
  TenantUpdated,
  TenantMigrated,
  TenantBackedUp,
  TenantRestored,
  TenantCloned,
  TenantQuotaExceeded,
  TenantEnteredMaintenance,
  TenantExitedMaintenance,
} from './events/index.js'
export type { TenantMigrationDirection } from './events/index.js'
export { InstallTenant, UninstallTenant } from './jobs/index.js'
// `CloneTenant` / `BackupTenant` / `RestoreTenant` moved to `@adonisjs-lasagna/backup`.
export {
  MissingTenantHeaderException,
  TenantNotFoundException,
  TenantSuspendedException,
  TenantNotReadyException,
  CircuitOpenException,
  QuotaExceededException,
  CentralRouteViolationException,
  TenantMaintenanceException,
  ImpersonationInvalidException,
  RateLimitUnavailableException,
  TenantHeaderDomainMismatchException,
  TooManyRequestsException,
} from './exceptions/index.js'
export type {
  ImpersonationContext,
  ImpersonationSession,
  ImpersonationStartOptions,
  ImpersonationStartResult,
} from './types/impersonation.js'
export { installRouterMacros, autoLoadScopedRouteFiles } from './extensions/router.js'
export { resolveTenantId } from './extensions/request.js'
export { defineConfig, setConfig, getConfig } from './config.js'
export { tenancy } from './tenancy.js'
export { withTenantScope, unscoped, isScopeBypassed } from './models/scoping.js'
export { setTenantRlsGuc, withTenantRls, DEFAULT_RLS_GUC } from './services/isolation/rls.js'
export type {
  RlsQueryRunner,
  RlsTransactor,
  SetTenantRlsGucOptions,
  WithTenantRlsOptions,
} from './services/isolation/rls.js'
export { encrypt, decrypt, isEncrypted } from './utils/crypto.js'
export { validateExternalHttpsUrl, validateResolvedHostIsPublic } from './utils/url.js'
