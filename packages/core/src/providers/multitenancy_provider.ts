import type { ApplicationService } from '@adonisjs/core/types'
import { Database } from '@adonisjs/lucid/database'
import logger from '@adonisjs/core/services/logger'
import { setConfig } from '../config.js'
import type { MultitenancyConfig } from '../types/config.js'
import { BackofficeAdapter, TenantAdapter } from '../models/adapters/index.js'
import { BackofficeBaseModel, TenantBaseModel, CentralBaseModel } from '../models/base/index.js'
import BootstrapperRegistry from '../services/bootstrapper_registry.js'
import cacheBootstrapper from '../services/bootstrappers/cache_bootstrapper.js'
import driveBootstrapper from '../services/bootstrappers/drive_bootstrapper.js'
import mailBootstrapper from '../services/bootstrappers/mail_bootstrapper.js'
import sessionBootstrapper from '../services/bootstrappers/session_bootstrapper.js'
import transmitBootstrapper from '../services/bootstrappers/transmit_bootstrapper.js'
import CircuitBreakerService from '../services/circuit_breaker_service.js'
import TenantQueueService from '../services/tenant_queue_service.js'
import HookRegistry from '../services/hook_registry.js'
import IsolationDriverRegistry from '../services/isolation/registry.js'
import { assertConfiguredDriverRegistered } from '../services/isolation/validate_driver_choice.js'
import SchemaPgDriver from '../services/isolation/schema_pg_driver.js'
import DatabasePgDriver from '../services/isolation/database_pg_driver.js'
import RowScopePgDriver from '../services/isolation/rowscope_pg_driver.js'
import SqliteMemoryDriver from '../services/isolation/sqlite_memory_driver.js'
import TenantResolverRegistry from '../services/resolvers/registry.js'
import { builtInResolvers } from '../services/resolvers/builtins.js'
import TenantLogContext from '../services/tenant_log_context.js'
import { primeTenancy } from '../tenancy.js'
import HealthService from '../health/health_service.js'
import { registerDefaultChecks } from '../health/default_checks.js'
import DoctorService from '../services/doctor/doctor_service.js'
import { builtInChecks } from '../services/doctor/checks/index.js'
import QuotaService from '../services/quota_service.js'
import ReadReplicaService from '../services/read_replica_service.js'
import TenantResolutionCache from '../services/tenant_resolution_cache.js'
import {
  TenantActivated,
  TenantSuspended,
  TenantDeleted,
  TenantUpdated,
  TenantProvisioned,
  TenantRestored,
  TenantEnteredMaintenance,
  TenantExitedMaintenance,
} from '../events/index.js'
import ResilienceService from '../services/resilience_service.js'
import CrossDomainRedirectService from '../services/cross_domain_redirect_service.js'
import ImpersonationService from '../services/impersonation_service.js'
import AuditLogService from '../services/audit_log_service.js'
// Billing (service, listeners, jobs, webhook route, drain) moved to
// `@adonisjs-lasagna/billing`; its own provider wires those against core
// events/hooks. The core provider no longer references billing.

export default class MultitenancyProvider {
  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton(BootstrapperRegistry, () => new BootstrapperRegistry())
    this.app.container.singleton(IsolationDriverRegistry, () => new IsolationDriverRegistry())
    this.app.container.singleton(TenantResolverRegistry, () => new TenantResolverRegistry())
    this.app.container.singleton(CircuitBreakerService, () => new CircuitBreakerService())
    // Instance-stateful (holds a per-tenant Queue map). Must be a singleton so
    // dispatch reuses connections and destroy/stats see a consistent map.
    this.app.container.singleton(TenantQueueService, () => new TenantQueueService())
    this.app.container.singleton(HookRegistry, () => new HookRegistry())
    this.app.container.singleton(TenantLogContext, () => new TenantLogContext())
    this.app.container.singleton(HealthService, () => new HealthService())
    this.app.container.singleton(DoctorService, () => {
      const svc = new DoctorService()
      for (const check of builtInChecks) svc.register(check)
      return svc
    })
    this.app.container.singleton(QuotaService, () => new QuotaService())
    this.app.container.singleton(ReadReplicaService, () => new ReadReplicaService())
    this.app.container.singleton(TenantResolutionCache, () => new TenantResolutionCache())
    this.app.container.singleton(ResilienceService, () => new ResilienceService())
    this.app.container.singleton(CrossDomainRedirectService, () => new CrossDomainRedirectService())
    this.app.container.singleton(AuditLogService, () => new AuditLogService())
    this.app.container.singleton(ImpersonationService, async (resolver) => {
      const auditLog = await resolver.make(AuditLogService)
      return new ImpersonationService({ auditLog })
    })
  }

  async boot() {
    const config = this.app.config.get<MultitenancyConfig>('multitenancy')
    this.#assertConfigShape(config)
    setConfig(config)

    BackofficeBaseModel.connection = config.backofficeConnectionName
    CentralBaseModel.connection = config.centralConnectionName

    const db = await this.app.container.make(Database)
    const drivers = await this.app.container.make(IsolationDriverRegistry)

    // Register the configured isolation driver before wiring the adapter,
    // because TenantAdapter consults the registry on every query.
    const choice = config.isolation?.driver ?? 'schema-pg'
    if (choice === 'schema-pg' && !drivers.has('schema-pg')) {
      drivers.register(
        new SchemaPgDriver({
          templateConnectionName: config.isolation?.templateConnectionName,
        }),
        { activate: true }
      )
    }
    if (choice === 'database-pg' && !drivers.has('database-pg')) {
      drivers.register(
        new DatabasePgDriver({
          templateConnectionName: config.isolation?.templateConnectionName,
          databasePrefix: config.isolation?.tenantDatabasePrefix,
        }),
        { activate: true }
      )
    }
    if (choice === 'rowscope-pg' && !drivers.has('rowscope-pg')) {
      drivers.register(
        new RowScopePgDriver({
          // rowscope-pg shares one connection across all tenants — the central
          // one. templateConnectionName is a clone-template concept that only
          // schema-pg/database-pg use, so rowscope reads centralConnectionName.
          centralConnectionName: config.centralConnectionName,
          scopedTables: config.isolation?.rowScopeTables,
          scopeColumn: config.isolation?.rowScopeColumn,
        }),
        { activate: true }
      )
    }
    // rowscope-pg's default isolation is the `withTenantScope` mixin —
    // convention, not enforcement. A hand-written top-level `orWhere` can escape
    // it. The enforced backstop is PostgreSQL RLS (the
    // `enable_rls_tenant_isolation` migration + `withTenantRls`). Warn whenever
    // rowscope-pg is the ACTIVE driver without the acknowledgment, regardless of
    // whether this provider registered it or a host pre-registered its own — the
    // pre-registered case arguably needs the hint most.
    if (choice === 'rowscope-pg' && !config.isolation?.rowScopeRls) {
      logger.warn(
        'multitenancy: isolation.driver is "rowscope-pg" without the RLS backstop. ' +
          'Tenant isolation is enforced only by the withTenantScope mixin (WHERE tenant_id = ?), ' +
          'which a top-level orWhere can escape. Ship the `enable_rls_tenant_isolation` migration ' +
          'and route queries through withTenantRls() for SQL-level enforcement, then set ' +
          'isolation.rowScopeRls=true to acknowledge it and silence this warning. ' +
          'See docs/data-isolation/rowscope-pg.'
      )
    }
    if (choice === 'sqlite-memory' && !drivers.has('sqlite-memory')) {
      drivers.register(new SqliteMemoryDriver(), { activate: true })
    }

    // Resolve the resolver registry before wiring the adapter so the adapter
    // can consult it synchronously for model-query routing (the chain is
    // seeded just below; the adapter holds the reference and reads it lazily).
    const resolvers = await this.app.container.make(TenantResolverRegistry)

    BackofficeBaseModel.$adapter = new BackofficeAdapter(db)
    TenantBaseModel.$adapter = new TenantAdapter(db, drivers, resolvers)

    // Seed the resolver registry with the built-ins and apply the
    // configured strategy (or chain). Apps can register additional
    // resolvers in their own provider's `boot()` after this one runs.
    for (const r of builtInResolvers) {
      if (!resolvers.has(r.name)) resolvers.register(r)
    }
    const chain =
      config.resolverChain && config.resolverChain.length > 0
        ? config.resolverChain
        : [config.resolverStrategy]
    resolvers.setChain(chain)

    // When the unified resolution path is enabled, seed the tenant log context
    // into `tenancy` so `tenancy.currentId()` reflects the HTTP guard's context
    // immediately (instead of depending on whether a queue job ran first). This
    // is what lets the adapter route a model query with the same id that
    // `request.tenant()` resolved, including domain-based resolvers.
    if (config.resolver?.legacyAdapterFallback !== true) {
      const logCtx = await this.app.container.make(TenantLogContext)
      primeTenancy(logCtx)
    }

    const hooks = await this.app.container.make(HookRegistry)
    hooks.loadDeclarative(config.hooks)

    // Default readiness checks live on the singleton from boot onward.
    // Host providers boot after this one, so their addCheck/removeCheck
    // calls override the defaults deterministically — the controller never
    // re-registers anything at probe time.
    registerDefaultChecks(await this.app.container.make(HealthService))

    const bootstrappers = await this.app.container.make(BootstrapperRegistry)
    if (!bootstrappers.has('cache')) bootstrappers.register(cacheBootstrapper)
    await this.#registerOptionalBootstrappers(bootstrappers)

    this.#validateImpersonationConfig(config)

    await this.#wireResolutionCacheInvalidation(config)

    await this.#registerQueueJobs()
  }

  /**
   * When the opt-in tenant-resolution cache is enabled, drop a tenant's cached
   * entry the moment its status changes in-process, so a suspend/maintenance/
   * delete takes effect immediately on this pod rather than waiting out the TTL.
   * (Cross-pod propagation is still bounded by the TTL — documented on the
   * config.) No-op when the cache is off. The emitter is resolved lazily so a
   * stripped-down container without it doesn't break boot.
   */
  async #wireResolutionCacheInvalidation(config: MultitenancyConfig): Promise<void> {
    if (!config.resolver?.cache?.enabled) return
    const emitter = await import('@adonisjs/core/services/emitter')
      .then((m) => m.default)
      .catch(() => null)
    if (!emitter) return

    const cache = await this.app.container.make(TenantResolutionCache)
    const lifecycleEvents = [
      TenantActivated,
      TenantSuspended,
      TenantDeleted,
      TenantUpdated,
      TenantProvisioned,
      TenantRestored,
      TenantEnteredMaintenance,
      TenantExitedMaintenance,
    ]
    for (const Event of lifecycleEvents) {
      emitter.on(Event, (event: { tenant?: { id?: string } }) => {
        const id = event?.tenant?.id
        if (id) cache.delete(id)
      })
    }
  }

  // Register package jobs with @adonisjs/queue's Locator. Host apps
  // auto-discover from `app/jobs/**`, which doesn't reach node_modules,
  // so without this dispatched InstallTenant/etc. dead-letter at the worker.
  // Best-effort — a host without @adonisjs/queue just skips it.
  async #registerQueueJobs(): Promise<void> {
    try {
      const { Locator } = await import('@adonisjs/queue')
      const jobs = await import('../jobs/index.js')
      for (const exported of Object.values(jobs)) {
        // Skip type-only re-exports — they erase to undefined at runtime.
        if (
          typeof exported !== 'function' ||
          typeof (exported as { dispatch?: unknown }).dispatch !== 'function'
        ) {
          continue
        }
        const JobClass = exported as { name: string; options?: { name?: string } }
        Locator.register(JobClass.options?.name ?? JobClass.name, JobClass as never)
      }
    } catch (error) {
      logger.warn(
        { err: (error as Error)?.message },
        '[multitenancy] could not auto-register queue jobs with the @adonisjs/queue Locator — dispatch a job through a worker only if you register them yourself'
      )
    }
  }

  /**
   * Asserts the shape that the rest of the package treats as load-bearing.
   * Cheaper than full schema validation, but catches the most common deploy
   * mistakes (missing required field, typoed strategy) at boot rather than
   * leaving them to surface as opaque "undefined" reads at request time.
   */
  #assertConfigShape(config: MultitenancyConfig | undefined): asserts config is MultitenancyConfig {
    if (!config) {
      throw new Error(
        'multitenancy config is missing. Add `config/multitenancy.ts` exporting `defineConfig({...})` ' +
          'and register `MultitenancyProvider` in `adonisrc.ts`.'
      )
    }

    const required = [
      'backofficeConnectionName',
      'centralConnectionName',
      'tenantConnectionNamePrefix',
      'tenantSchemaPrefix',
      'resolverStrategy',
    ] as const
    for (const key of required) {
      if (!config[key]) {
        throw new Error(`multitenancy.${key} is required but missing or empty.`)
      }
    }

    const knownStrategies = ['subdomain', 'header', 'path', 'domain-or-subdomain', 'request-data']
    if (!knownStrategies.includes(config.resolverStrategy)) {
      throw new Error(
        `multitenancy.resolverStrategy "${config.resolverStrategy}" is not one of ` +
          `${knownStrategies.join(', ')}.`
      )
    }

    if (config.resolverChain) {
      if (!Array.isArray(config.resolverChain) || config.resolverChain.length === 0) {
        throw new Error('multitenancy.resolverChain must be a non-empty array when set.')
      }
    }
  }

  /**
   * If the host opted into impersonation by adding an `impersonation` block,
   * the secret has to clear the same bar as ImpersonationService#secret().
   * We check it here so a bad deploy fails on boot — not later, when the
   * first admin tries to `start()` a session and the request stalls.
   */
  #validateImpersonationConfig(config: MultitenancyConfig): void {
    if (!config.impersonation) return
    const secret = config.impersonation.secret
    if (!secret || secret.length < 32) {
      throw new Error(
        'multitenancy.impersonation.secret is missing or shorter than 32 characters. ' +
          'Set it to a long random string (e.g. `openssl rand -hex 32`) before booting the app.'
      )
    }
  }

  /**
   * Auto-register the bootstrappers whose peer dependencies are wired
   * into the host app. We probe `container.hasBinding(...)` instead of
   * importing the service module directly, because the service-main
   * files in `@adonisjs/mail` etc. eagerly `container.make()` the
   * binding — which throws if the host hasn't loaded the provider that
   * registers it. Detection via the binding name is both cheaper and
   * exact: the bootstrapper is only useful when the host app actually
   * configured the underlying service.
   */
  async #registerOptionalBootstrappers(bootstrappers: BootstrapperRegistry): Promise<void> {
    const candidates = [
      { name: 'drive', binding: 'drive.manager', bootstrapper: driveBootstrapper },
      { name: 'mail', binding: 'mail.manager', bootstrapper: mailBootstrapper },
      { name: 'session', binding: 'session', bootstrapper: sessionBootstrapper },
      { name: 'transmit', binding: 'transmit', bootstrapper: transmitBootstrapper },
    ] as const

    const containerLogger = await this.app.container.make('logger').catch(() => undefined)

    for (const c of candidates) {
      if (bootstrappers.has(c.name)) continue
      if (this.app.container.hasBinding(c.binding)) {
        bootstrappers.register(c.bootstrapper)
      } else {
        containerLogger?.debug(
          { bootstrapper: c.name, binding: c.binding },
          'multitenancy: peer service not bound; skipping bootstrapper'
        )
      }
    }
  }

  async start() {
    await import('../extensions/request.js')

    const { installRouterMacros, autoLoadScopedRouteFiles } =
      await import('../extensions/router.js')
    await installRouterMacros()

    const config = this.app.config.get<MultitenancyConfig>('multitenancy')

    // Every provider's boot() has run by now, so a custom driver registered
    // by the host is visible. A typo'd built-in name compiles (the choice
    // type is open for custom drivers) — catch it here, at boot, instead of
    // letting the first tenant query fail with a generic "no active driver".
    const drivers = await this.app.container.make(IsolationDriverRegistry)
    assertConfiguredDriverRegistered(drivers, config.isolation?.driver ?? 'schema-pg')
    if (config.routing?.autoLoad !== false) {
      await autoLoadScopedRouteFiles(this.app, {
        tenantRoutesFile: config.routing?.tenantRoutesFile,
        universalRoutesFile: config.routing?.universalRoutesFile,
      })
    }
  }

  /**
   * Invalidate module-level caches that hold references to container
   * singletons — see {@link resetModuleCaches} for the why. The billing
   * metering drain moved to the @adonisjs-lasagna/billing provider's
   * shutdown.
   */
  async shutdown() {
    const { resetModuleCaches } = await import('./shutdown_caches.js')
    await resetModuleCaches()
  }
}
