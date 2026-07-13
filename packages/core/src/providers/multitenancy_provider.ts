import type { ApplicationService } from '@adonisjs/core/types'
import { Database } from '@adonisjs/lucid/database'
import { getConfig, setConfig } from '../config.js'
import { assertConfigBounds } from './assert_config_bounds.js'
import { assertPluginLimits } from './assert_plugin_limits.js'
import { resolutionSafetyAudit } from './resolution_safety.js'
import {
  assertRowScopeRlsPresent,
  assertRowScopeTablesDeclared,
  probeRlsCatalog,
} from '../services/isolation/rls_boot_probe.js'
import type { MultitenancyConfig } from '../types/config.js'
import { TenantAdapter } from '../models/adapters/index.js'
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
import { BUILT_IN_ISOLATION_DRIVERS } from '../services/isolation/built_in_drivers.js'
import TenantResolverRegistry from '../services/resolvers/registry.js'
import { wireResolverChain } from './resolver_chain.js'
import { setResolverRegistry } from '../extensions/request.js'
import TenantLogContext from '../services/tenant_log_context.js'
import { primeTenancy } from '../tenancy.js'
import HealthService from '../health/health_service.js'
import { registerDefaultChecks } from '../health/default_checks.js'
import DoctorService from '../services/doctor/doctor_service.js'
import { builtInChecks } from '../services/doctor/checks/index.js'
import ComplianceReportService from '../services/compliance/compliance_report_service.js'
import { builtInControls } from '../services/compliance/controls/index.js'
import QuotaService from '../services/quota_service.js'
import ReadReplicaService from '../services/read_replica_service.js'
import TenantResolutionCache from '../services/tenant_resolution_cache.js'
import { wireResolutionCacheInvalidation } from './resolution_cache_invalidation.js'
import ResilienceService from '../services/resilience_service.js'
import CrossDomainRedirectService from '../services/cross_domain_redirect_service.js'
import ImpersonationService from '../services/impersonation_service.js'
import AuditLogService from '../services/audit_log_service.js'
import AuditLogDestinationRegistry from '../services/audit_log_destination_registry.js'
import EvaluationStrategyRegistry from '../services/evaluation_strategy_registry.js'
import WebhookTransformerRegistry from '../services/webhook_transformer_registry.js'
import AuthorizerRegistry from '../services/authorizer_registry.js'
import TenantMiddlewareRegistry from '../services/tenant_middleware_registry.js'
import CapabilityRegistry from '../services/capability_registry.js'
import TenantSchedulerService from '../services/tenant_scheduler_service.js'
// Billing (service, listeners, jobs, webhook route, drain) moved to
// `@adonisjs-lasagna/billing`; its own provider wires those against core
// events/hooks. The core provider no longer references billing.

export default class MultitenancyProvider {
  /** Lifecycle disposers, torn down LIFO in shutdown(). Wired in ready(). */
  #disposers: Array<() => void | Promise<void>> = []

  constructor(protected app: ApplicationService) {}

  /**
   * Emit a boot diagnostic once the app is booted, where the container logger is
   * guaranteed to exist. provider boot() runs before the eager logger binding
   * materializes, so logging inline forced a defensive
   * `container.make('logger').catch(() => undefined)` that could silently swallow
   * a warning — the worst failure mode for a security diagnostic. Deferring to
   * app.booted removes both the race and the silent drop.
   */
  #warnWhenBooted(
    emit: (logger: { warn: (...args: any[]) => void; debug: (...args: any[]) => void }) => void
  ): void {
    void this.app.booted(async () => {
      try {
        const logger = (await this.app.container.make('logger')) as {
          warn: (...args: any[]) => void
          debug: (...args: any[]) => void
        }
        emit(logger)
      } catch {
        // A boot diagnostic must never fail app startup. By app.booted the logger
        // is expected to resolve, so this only guards a pathological make()/emit
        // failure; swallow it rather than let it reject out of the booted-hook
        // runner and take the whole boot down over a warning.
      }
    })
  }

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
    this.app.container.singleton(ComplianceReportService, () => {
      const svc = new ComplianceReportService()
      for (const control of builtInControls) svc.register(control)
      return svc
    })
    this.app.container.singleton(QuotaService, () => new QuotaService())
    this.app.container.singleton(ReadReplicaService, () => new ReadReplicaService())
    this.app.container.singleton(TenantResolutionCache, () => new TenantResolutionCache())
    this.app.container.singleton(ResilienceService, () => new ResilienceService())
    this.app.container.singleton(CrossDomainRedirectService, () => new CrossDomainRedirectService())
    this.app.container.singleton(AuditLogService, () => new AuditLogService())
    // Extension-surface registries (host-populated, Map-backed). Singletons so a
    // host's registrations are visible to the services that consult them.
    this.app.container.singleton(
      AuditLogDestinationRegistry,
      () => new AuditLogDestinationRegistry()
    )
    this.app.container.singleton(EvaluationStrategyRegistry, () => new EvaluationStrategyRegistry())
    this.app.container.singleton(WebhookTransformerRegistry, () => new WebhookTransformerRegistry())
    // Plugin-platform registries (host/plugin-populated, Map-backed). Singletons
    // so a plugin's boot-time registrations are visible where core consumes them:
    // the authorizer chain in TenantGuardMiddleware, the middleware registry when
    // installRouterMacros pre-resolves each scope, the capability registry at
    // consume time.
    this.app.container.singleton(AuthorizerRegistry, () => new AuthorizerRegistry())
    this.app.container.singleton(TenantMiddlewareRegistry, () => new TenantMiddlewareRegistry())
    this.app.container.singleton(CapabilityRegistry, () => new CapabilityRegistry())
    // Fans a periodic tick out over active tenants. Singleton so a plugin's
    // boot-time schedule registrations are the ones ready() arms as native
    // @adonisjs/queue schedules.
    this.app.container.singleton(TenantSchedulerService, () => new TenantSchedulerService())
    // Sync factory: the audit log is resolved lazily from the container inside
    // ImpersonationService#audit(), so this no longer needs to be the sole async
    // factory among the provider's singletons.
    this.app.container.singleton(ImpersonationService, () => new ImpersonationService())
  }

  async boot() {
    const config = this.app.config.get<MultitenancyConfig>('multitenancy')
    this.#assertConfigShape(config)
    // The app is the single authority for which environment we are in: the
    // resolution-safety gate keys on dev/test (fail closed otherwise), and the
    // second-set refusal on production. Both come from `this.app` here so neither
    // re-reads NODE_ENV behind the framework's back.
    assertConfigBounds(config, { inDevOrTest: this.app.inDev || this.app.inTest })
    setConfig(config, { inProduction: this.app.inProduction })

    BackofficeBaseModel.connection = config.backofficeConnectionName
    CentralBaseModel.connection = config.centralConnectionName

    const db = await this.app.container.make(Database)
    const drivers = await this.app.container.make(IsolationDriverRegistry)

    // Register the configured isolation driver into the registry made above.
    // The adapter reads the registry lazily on each query, so registering the
    // driver before the adapter is wired below is convenience, not a
    // requirement: the load-bearing constraints are that the driver is
    // registered before start()'s assertConfiguredDriverRegistered and before
    // the first tenant query. Built-in construction is a data-driven lookup
    // (BUILT_IN_ISOLATION_DRIVERS): a custom `choice` misses the map and is left
    // for the host to register in its own boot() (start() then verifies it).
    const choice = config.isolation?.driver ?? 'schema-pg'
    const buildDriver = BUILT_IN_ISOLATION_DRIVERS[choice]
    if (buildDriver && !drivers.has(choice)) {
      drivers.register(buildDriver(config), { activate: true })
    }
    // rowscope-pg's default isolation is the `withTenantScope` mixin:
    // convention, not enforcement. A hand-written top-level `orWhere` can escape
    // it. The enforced backstop is PostgreSQL RLS (the
    // `enable_rls_tenant_isolation` migration + `withTenantRls`). Warn whenever
    // rowscope-pg is the ACTIVE driver without the acknowledgment, regardless of
    // whether this provider registered it or a host pre-registered its own. The
    // pre-registered case arguably needs the hint most. Deferred to app.booted:
    // the `@adonisjs/core/services/logger` binding only materializes once the app
    // reaches `booted`, and provider boot() runs before that, so warning inline
    // could silently drop this security hint.
    if (choice === 'rowscope-pg' && !config.isolation?.rowScopeRls) {
      this.#warnWhenBooted((logger) =>
        logger.warn(
          'multitenancy: isolation.driver is "rowscope-pg" without the RLS backstop. ' +
            'Tenant isolation is enforced only by the withTenantScope mixin (WHERE tenant_id = ?), ' +
            'which a top-level orWhere can escape. Ship the `enable_rls_tenant_isolation` migration ' +
            'and route queries through withTenantRls() for SQL-level enforcement, then set ' +
            'isolation.rowScopeRls=true to acknowledge it and silence this warning. ' +
            'See docs/data-isolation/rowscope-pg.'
        )
      )
    }
    // When the operator ASSERTS the RLS backstop is in place (rowScopeRls=true),
    // verify the claim at boot instead of trusting it: probe pg_class/pg_policies
    // for every scoped table and fail closed (IsolationConfigException) if RLS is
    // not ENABLED + FORCED + policied. A half-applied migration must not boot
    // looking protected while the mixin is the only real boundary.
    if (choice === 'rowscope-pg' && config.isolation?.rowScopeRls === true) {
      const tables = config.isolation?.rowScopeTables ?? []
      // Fail closed on the empty-list false-green: rowScopeRls=true with no tables
      // used to skip the probe and report protected while nothing was verified.
      assertRowScopeTablesDeclared(tables)
      const scopeColumn = config.isolation?.rowScopeColumn ?? 'tenant_id'
      const rows = await probeRlsCatalog(
        db as any,
        config.centralConnectionName,
        config.centralSchemaName,
        tables,
        scopeColumn
      )
      assertRowScopeRlsPresent(rows, tables, scopeColumn)
    }

    // F1 observable boot warning: the absolute connection ceiling is the tier
    // ABOVE the soft cap. Set BELOW maxTenantConnections it breaks the pool — new
    // tenants are refused (503) before the size ever exceeds the cap, so the
    // in-use-aware LRU never runs to shed idle connections, and requests are
    // refused while evictable connections sit open. Deferred to app.booted for the
    // logger, like the rowscope hint above.
    if (choice === 'schema-pg' || choice === 'database-pg') {
      const iso = getConfig().isolation
      const ceiling = iso.maxTenantConnectionsHardCeiling
      if (ceiling !== undefined && ceiling < iso.maxTenantConnections) {
        this.#warnWhenBooted((logger) =>
          logger.warn(
            `multitenancy: isolation.maxTenantConnectionsHardCeiling (${ceiling}) is below ` +
              `maxTenantConnections (${iso.maxTenantConnections}). The absolute ceiling is the tier ABOVE ` +
              `the soft cap; set below it, the pool is refused (503) before the LRU ever evicts an idle ` +
              `connection, so new tenants can be refused while evictable connections stay open. Set the ` +
              `ceiling as generous headroom ABOVE maxTenantConnections.`
          )
        )
      }
    }

    // Resolve the resolver registry singleton: the adapter takes it as a
    // constructor dependency below, so the object must exist here. Its contents
    // (the chain) are seeded just after wiring and read lazily per query, so the
    // seed order relative to adapter construction is not load-bearing.
    const resolvers = await this.app.container.make(TenantResolverRegistry)

    // One unified adapter for all three base models. It routes by each model's
    // declarative `static isolation` marker (tenant / backoffice / central)
    // rather than by which adapter subclass was attached, so the base classes
    // are thin shims that just set the marker (see models/base/isolation_kind).
    const unifiedAdapter = new TenantAdapter(db, drivers, resolvers)
    TenantBaseModel.$adapter = unifiedAdapter
    BackofficeBaseModel.$adapter = unifiedAdapter
    CentralBaseModel.$adapter = unifiedAdapter

    // Seed the resolver registry with the built-ins + any host-provided inline
    // resolver instances, then apply the configured strategy (or chain). Apps
    // can register additional resolvers in their own provider's `boot()` after
    // this one runs. See providers/resolver_chain.
    wireResolverChain(resolvers, config)

    // Seed the resolver registry into the request module cache so the chain-aware
    // resolveTenantId (rate-limit, metrics attribution) has a GUARANTEED synchronous
    // hit from the first request without rebuilding the chain from config on the hot
    // path. Attribution then follows the SAME chain routing serves — the fix for the
    // cross-tenant rate-limit/metrics misattribution (TRES-01).
    setResolverRegistry(resolvers)

    // Resolution-safety signal. Both the cross-tenant IDOR posture (a
    // client-controlled strategy with no `authorizeTenantAccess`) and the
    // unbounded host-trust posture (a host strategy with no expectedHostSuffix)
    // are derived from one audit, the same one the `membership_gate` doctor check
    // and the fail-closed check in assertConfigBounds consume. assertConfigBounds
    // already hard-failed any finding outside a recognized dev/test env, so
    // reaching here with findings means a dev/test boot: warn instead. Deferred to
    // app.booted so the container logger is guaranteed and the warning is never
    // silently dropped.
    const resolutionRisks = resolutionSafetyAudit(config)
    if (resolutionRisks.length > 0) {
      this.#warnWhenBooted((logger) => {
        for (const risk of resolutionRisks) logger.warn(risk.message)
      })
    }

    // Seed the tenant log context into `tenancy` so `tenancy.currentId()` reflects
    // the HTTP guard's context immediately (instead of depending on whether a queue
    // job ran first). This is what lets the adapter route a model query with the
    // same id that `request.tenant()` resolved, including domain-based resolvers.
    const logCtx = await this.app.container.make(TenantLogContext)
    primeTenancy(logCtx)

    const hooks = await this.app.container.make(HookRegistry)
    hooks.loadDeclarative(config.hooks)

    // Default readiness checks live on the singleton from boot onward.
    // Host providers boot after this one, so their addCheck/removeCheck
    // calls override the defaults deterministically, and the controller never
    // re-registers anything at probe time.
    registerDefaultChecks(await this.app.container.make(HealthService))

    const bootstrappers = await this.app.container.make(BootstrapperRegistry)
    if (!bootstrappers.has('cache')) bootstrappers.register(cacheBootstrapper)
    this.#registerOptionalBootstrappers(bootstrappers)

    await this.#registerQueueJobs()
  }

  // Register package jobs with @adonisjs/queue's Locator. Host apps
  // auto-discover from `app/jobs/**`, which doesn't reach node_modules,
  // so without this dispatched InstallTenant/etc. dead-letter at the worker.
  // Best-effort: a host without @adonisjs/queue just skips it.
  async #registerQueueJobs(): Promise<void> {
    try {
      const { Locator } = await import('@adonisjs/queue')
      const jobs = await import('../jobs/index.js')
      for (const exported of Object.values(jobs)) {
        // Skip type-only re-exports, which erase to undefined at runtime.
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
      // Deferred to app.booted: this runs during boot(), before the eager
      // `@adonisjs/core/services/logger` binding exists (same constraint as the
      // rowscope warning above), and a dropped warning here would hide a real
      // dispatch gap.
      this.#warnWhenBooted((logger) =>
        logger.warn(
          { err: (error as Error)?.message },
          '[multitenancy] could not auto-register queue jobs with the @adonisjs/queue Locator — dispatch a job through a worker only if you register them yourself'
        )
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
   * Auto-register the bootstrappers whose peer dependencies are wired
   * into the host app. We probe `container.hasBinding(...)` instead of
   * importing the service module directly, because the service-main
   * files in `@adonisjs/mail` etc. eagerly `container.make()` the
   * binding, which throws if the host hasn't loaded the provider that
   * registers it. Detection via the binding name is both cheaper and
   * exact: the bootstrapper is only useful when the host app actually
   * configured the underlying service.
   */
  #registerOptionalBootstrappers(bootstrappers: BootstrapperRegistry): void {
    const candidates = [
      { name: 'drive', binding: 'drive.manager', bootstrapper: driveBootstrapper },
      { name: 'mail', binding: 'mail.manager', bootstrapper: mailBootstrapper },
      { name: 'session', binding: 'session', bootstrapper: sessionBootstrapper },
      { name: 'transmit', binding: 'transmit', bootstrapper: transmitBootstrapper },
    ] as const

    for (const c of candidates) {
      if (bootstrappers.has(c.name)) continue
      if (this.app.container.hasBinding(c.binding)) {
        bootstrappers.register(c.bootstrapper)
      } else {
        this.#warnWhenBooted((logger) =>
          logger.debug(
            { bootstrapper: c.name, binding: c.binding },
            'multitenancy: peer service not bound; skipping bootstrapper'
          )
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
    // type is open for custom drivers), so catch it here, at boot, instead of
    // letting the first tenant query fail with a generic "no active driver".
    const drivers = await this.app.container.make(IsolationDriverRegistry)
    assertConfiguredDriverRegistered(drivers, config.isolation?.driver ?? 'schema-pg')

    // Fail-closed cap enforcement for the plugin request-path surfaces. Runs here,
    // in start(), because every provider's boot() has completed, so a plugin's
    // authorizer/middleware/capability registrations are final and countable. A
    // surface over its configured cap aborts the deploy (PluginBootException); an
    // omitted cap is unlimited. No-op unless a host sets `plugins.limits`.
    const [authorizers, middleware, capabilities, scheduler] = await Promise.all([
      this.app.container.make(AuthorizerRegistry),
      this.app.container.make(TenantMiddlewareRegistry),
      this.app.container.make(CapabilityRegistry),
      this.app.container.make(TenantSchedulerService),
    ])
    assertPluginLimits(config.plugins?.limits, {
      authorizers: authorizers.list().length,
      middleware: middleware.list().length,
      capabilities: capabilities.list().length,
      schedules: scheduler.list().length,
    })

    if (config.routing?.autoLoad !== false) {
      await autoLoadScopedRouteFiles(this.app, {
        ...(config.routing?.tenantRoutesFile !== undefined
          ? { tenantRoutesFile: config.routing.tenantRoutesFile }
          : {}),
        ...(config.routing?.universalRoutesFile !== undefined
          ? { universalRoutesFile: config.routing.universalRoutesFile }
          : {}),
      })
    }
  }

  /**
   * When the opt-in tenant-resolution cache is enabled, drop a tenant's cached
   * entry the moment a lifecycle event changes its status in-process, so a
   * suspend / maintenance / delete takes effect immediately on this pod instead
   * of waiting out the TTL. (Cross-pod propagation stays bounded by the TTL,
   * documented on the config.) No-op when the cache is off.
   *
   * Wired in `ready()`, NOT `boot()`: the emitter is only fully constructed once
   * the app is booted, so resolving it during boot() returns an unwired emitter
   * and silently drops every subscription. `ready()` runs after the booted
   * hooks (the same lifecycle the satellite providers use for listeners), and
   * the emitter comes from the container, never the `services/emitter` module,
   * which resolves to `undefined` mid-boot. It is resolved defensively so a
   * stripped-down container without an emitter can't break startup.
   */
  async ready() {
    // Arm plugin schedules as native @adonisjs/queue schedules. Runs in ready()
    // (after every provider boot(), so all schedule registrations are final AND
    // the queue backend is initialized) and BEFORE the cache-invalidation early
    // return below, so a host without the resolution cache still gets its
    // schedules armed. No-op unless a plugin registered a schedule. Fail-closed in
    // the worker/console process (a declared schedule that can't be armed aborts
    // the deploy); fail-open in the web process (the worker arms the shared
    // schedule anyway, so a queue-backend blip must not fail web readiness).
    const env = this.app.getEnvironment()
    await (
      await this.app.container.make(TenantSchedulerService)
    ).start({
      failClosed: env !== 'web',
    })

    const config = this.app.config.get<MultitenancyConfig>('multitenancy')
    if (!config.resolver?.cache?.enabled) return
    const emitter = await this.app.container.make('emitter').catch(() => null)
    if (!emitter) return
    const cache = await this.app.container.make(TenantResolutionCache)
    // Capture the teardown so shutdown() removes these lifecycle listeners again.
    // Without it, a ready()/shutdown() cycle (repeated boots in one process — the
    // integration suite, a reloading worker) leaks one listener set per cycle and
    // the emitter's listener count climbs unbounded.
    this.#disposers.push(wireResolutionCacheInvalidation(emitter, cache))
  }

  /**
   * Graceful teardown on `app.terminate()` (the SIGTERM path in worker/web
   * processes). Three steps, in order:
   *
   * 1. Run the lifecycle disposers registered during ready() in reverse (LIFO),
   *    chiefly the resolution-cache-invalidation listeners, so our emitter
   *    subscriptions are detached before the singletons they reference are torn
   *    down.
   * 2. Close the long-lived libuv handles our singletons own (see
   *    {@link closeOwnedHandles}) — chiefly `TenantQueueService`'s per-tenant
   *    BullMQ queues, whose ioredis sockets would otherwise keep the event loop
   *    alive after terminate() and hang the process until SIGKILL.
   * 3. Invalidate module-level caches that hold references to container
   *    singletons (see {@link resetModuleCaches} for the why).
   *
   * Handles before caches: dropping the module-cache references before releasing
   * the sockets would orphan the very services that still own them. The billing
   * metering drain moved to the @adonisjs-lasagna/billing provider's shutdown.
   */
  async shutdown() {
    // LIFO teardown of what ready() wired (the cache-invalidation listeners),
    // before the singletons they close over are released below. Each disposer is
    // isolated: a throwing one must never skip closeOwnedHandles, which drains the
    // BullMQ sockets that otherwise keep the event loop alive and hang SIGTERM.
    for (const dispose of this.#disposers.reverse()) {
      try {
        await dispose()
      } catch (error) {
        const logger = await this.app.container.make('logger').catch(() => undefined)
        logger?.warn(
          { err: (error as Error)?.message },
          '[multitenancy] a shutdown disposer threw; continuing teardown'
        )
      }
    }
    this.#disposers = []

    const { closeOwnedHandles } = await import('./shutdown_handles.js')
    await closeOwnedHandles(this.app)

    const { resetModuleCaches } = await import('./shutdown_caches.js')
    await resetModuleCaches()
  }
}
