/**
 * Public API surface and its stability tiers.
 *
 * This root barrel plus the documented subpaths in package.json `exports`
 * (`/services`, `/middleware`, `/events`, `/types`, `/testing`, `/health`,
 * `/sdk`, ...) are the stable, app-facing API. The root is deliberately a
 * curated subset: the high-level services, base models, adapters, middleware,
 * events, exceptions, contracts, and the extension registries
 * (`IsolationDriverRegistry`, `TenantResolverRegistry`) an app actually reaches
 * for. Service classes are exported because they double as the container's DI
 * tokens — resolve instances with `app.container.make(TheService)`, don't `new`
 * them.
 *
 * The concrete built-in implementations (the `*PgDriver` isolation drivers, the
 * `*Resolver` classes, `ResolverHit`, `builtInResolvers`) live on `/services`
 * only. An app selects a driver by config string (`isolation.driver`) and a
 * resolver chain by name, so it never imports those classes directly; the only
 * caller is someone authoring a custom driver/resolver, who is already in
 * "advanced" territory and reaching for the granular subpath.
 *
 * `/internal` is explicitly NOT stable and may change between minors. Anything a
 * third-party satellite legitimately needs is mirrored onto a stable surface.
 *
 * An architectural test (tests/architectural/public_api_surface.spec.ts) guards
 * this contract: it keeps the root from drifting out of sync with `/services`
 * and from re-exporting `/internal`.
 */
export type {
  MultitenancyConfig,
  TenantResolverStrategy,
  TenantAccessAuthorizer,
  IsolationConfig,
  IsolationDriverChoice,
  RequestDataResolverConfig,
  RoutingConfig,
  PluginPlatformConfig,
  PluginLimitsConfig,
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
  resolveTenantRepository,
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
  configuredScopeColumn,
  getActiveDriver,
  TenantResolverRegistry,
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
  LogOptions,
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
  TableLocation,
  TableLocationSchema,
  TableLocationDatabase,
  TableLocationRowscope,
  TableLocationConnection,
  TenantResolver,
  TenantResolveResult,
  TenantLogContextData,
  QuotaCheckResult,
  QuotaStateSnapshot,
  QuotaReservation,
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
// `InstallTenant` / `UninstallTenant` / `TenantJob` (and `TenantJobPayload`) are
// NOT re-exported here: they `extends Job` from the optional `@adonisjs/queue`
// peer, so re-exporting them from the package's main entry would pull the queue
// into the module graph of every `import '@adonisjs-lasagna/saas-tenancy'` and
// break a host that doesn't run background jobs. Import them from the dedicated
// `@adonisjs-lasagna/saas-tenancy/jobs` subpath, which a queue-using host loads
// explicitly. (Architectural guard: tests/architectural/jobs_lazy_import_queue.spec.ts.)
export { buildTenantWorkerOptions } from './helpers/index.js'
// `CloneTenant` / `BackupTenant` / `RestoreTenant` moved to `@adonisjs-lasagna/backup`.
export {
  MissingTenantHeaderException,
  TenantNotFoundException,
  TenantSuspendedException,
  TenantAccessForbiddenException,
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
export {
  encrypt,
  decrypt,
  decryptStrict,
  decryptWithAppKey,
  isEncrypted,
  sealV2WithKey,
  openV2WithKey,
} from './utils/crypto.js'
export { readSecret, writeSecret, SECRET_CLASS } from './utils/secret_at_rest.js'
export type { SecretClass } from './utils/secret_at_rest.js'
export { validateExternalHttpsUrl, validateResolvedHostIsPublic } from './utils/url.js'
export { safeFetch, SafeFetchError, TRUSTED_FETCH_HOSTS } from './utils/safe_fetch.js'
export type { SafeFetchOptions } from './utils/safe_fetch.js'
