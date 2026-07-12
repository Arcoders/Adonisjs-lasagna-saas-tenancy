/**
 * Public API surface and its stability tiers.
 *
 * This root barrel plus the documented subpaths in package.json `exports`
 * (`/services`, `/middleware`, `/events`, `/types`, `/testing`, `/health`,
 * `/sdk`, ...) are the stable, app-facing API. The root is deliberately a
 * curated subset: the three base models and their adapters, the middleware, the
 * high-level services, the events, the exceptions, the contracts, and the
 * routing and scoping helpers an app actually reaches for. Service classes are
 * exported because they double as the container's DI tokens: resolve instances
 * with `app.container.make(TheService)`, don't `new` them.
 *
 * Plumbing an app never hand-imports lives on its subpath only, so the root
 * stays small enough to keep as a promise. The extension registries
 * (`HookRegistry`, `BootstrapperRegistry`, `IsolationDriverRegistry`,
 * `TenantResolverRegistry`), the bootstrapper helpers, the concrete built-in
 * `*PgDriver` / `*Resolver` implementations and the service type cluster are on
 * `/services`. The six satellite models are on `/models/satellites`. `safeFetch`
 * is on `/safe-fetch`. An app selects a driver by config string
 * (`isolation.driver`) and a resolver chain by name, so it never imports those
 * classes directly; the only caller is someone authoring a custom
 * driver/resolver, who is already in "advanced" territory and reaching for the
 * granular subpath.
 *
 * `readSecret` / `writeSecret` / `SECRET_CLASS` stay here because storing a
 * webhook or SSO secret at rest is a host-app job. The envelope primitives they
 * compose (`encrypt`, `sealV2WithKey`, `decryptWithAppKey`, ...) and the SSRF
 * URL guards moved to `/internal`.
 *
 * `/internal` is explicitly NOT stable and may change between minors. Anything a
 * third-party satellite legitimately needs is mirrored onto a stable surface.
 *
 * An architectural test (tests/@architecture/contracts/public_api_surface.spec.ts)
 * guards this contract: it keeps the root from drifting out of sync with
 * `/services` and from re-exporting `/internal`.
 */
export type {
  MultitenancyConfig,
  TenantResolverStrategy,
  TenantAccessAuthorizer,
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
export { BackofficeBaseModel, TenantBaseModel, CentralBaseModel } from './models/base/index.js'
export { DefaultLucidAdapter, TenantAdapter } from './models/adapters/index.js'
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
  TenantLogContext,
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
export { readSecret, writeSecret, SECRET_CLASS } from './utils/secret_at_rest.js'
export type { SecretClass } from './utils/secret_at_rest.js'

/**
 * `node ace configure @adonisjs-lasagna/saas-tenancy` imports THIS module and calls its
 * `configure` named export: @adonisjs/core's configure command does `app.import(pkg)`
 * and then reads `packageExports.configure`. Without this line the command warns
 * "the module does not export the configure hook" and publishes nothing, leaving the
 * very first command in the quickstart a silent no-op.
 *
 * `@adonisjs/lucid` re-exports its hook from its root entry the same way. Keep it on
 * the root barrel however far the barrel is trimmed.
 */
export { default as configure } from '../configure.js'
