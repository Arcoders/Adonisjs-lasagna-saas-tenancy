import type { ApplicationService } from '@adonisjs/core/types'
import { Database } from '@adonisjs/lucid/database'
import { setConfig } from '../config.js'
import { assertConfigBounds } from './assert_config_bounds.js'
import { membershipGateRisk } from '../services/membership_gate.js'
import { hostTrustWarning } from './assert_host_trust.js'
import { assertRowScopeRlsPresent, probeRlsCatalog } from '../services/isolation/rls_boot_probe.js'
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
import SchemaPgDriver from '../services/isolation/schema_pg_driver.js'
import DatabasePgDriver from '../services/isolation/database_pg_driver.js'
import RowScopePgDriver from '../services/isolation/rowscope_pg_driver.js'
import SqliteMemoryDriver from '../services/isolation/sqlite_memory_driver.js'
import TenantResolverRegistry from '../services/resolvers/registry.js'
import { wireResolverChain } from './resolver_chain.js'
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
    this.app.container.singleton(ImpersonationService, async (resolver) => {
      const auditLog = await resolver.make(AuditLogService)
      return new ImpersonationService({ auditLog })
    })
  }

  async boot() {
    const config = this.app.config.get<MultitenancyConfig>('multitenancy')
    this.#assertConfigShape(config)
    assertConfigBounds(config)
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
    // pre-registered case arguably needs the hint most. The logger MUST come
    // from the container here: the `@adonisjs/core/services/logger` binding
    // only materializes once the app reaches `booted`, and provider boot()
    // runs before that, so the eager import is still undefined at this point.
    if (choice === 'rowscope-pg' && !config.isolation?.rowScopeRls) {
      const bootLogger = await this.app.container.make('logger').catch(() => undefined)
      bootLogger?.warn(
        'multitenancy: isolation.driver is "rowscope-pg" without the RLS backstop. ' +
          'Tenant isolation is enforced only by the withTenantScope mixin (WHERE tenant_id = ?), ' +
          'which a top-level orWhere can escape. Ship the `enable_rls_tenant_isolation` migration ' +
          'and route queries through withTenantRls() for SQL-level enforcement, then set ' +
          'isolation.rowScopeRls=true to acknowledge it and silence this warning. ' +
          'See docs/data-isolation/rowscope-pg.'
      )
    }
    // When the operator ASSERTS the RLS backstop is in place (rowScopeRls=true),
    // verify the claim at boot instead of trusting it: probe pg_class/pg_policies
    // for every scoped table and fail closed (IsolationConfigException) if RLS is
    // not ENABLED + FORCED + policied. A half-applied migration must not boot
    // looking protected while the mixin is the only real boundary.
    if (choice === 'rowscope-pg' && config.isolation?.rowScopeRls === true) {
      const tables = config.isolation?.rowScopeTables ?? []
      if (tables.length > 0) {
        const rows = await probeRlsCatalog(
          db as any,
          config.centralConnectionName,
          config.centralSchemaName,
          tables
        )
        assertRowScopeRlsPresent(rows, tables)
      }
    }
    if (choice === 'sqlite-memory' && !drivers.has('sqlite-memory')) {
      drivers.register(new SqliteMemoryDriver(), { activate: true })
    }

    // Resolve the resolver registry before wiring the adapter so the adapter
    // can consult it synchronously for model-query routing (the chain is
    // seeded just below; the adapter holds the reference and reads it lazily).
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

    // Cross-tenant IDOR signal. A client-controlled resolver strategy
    // (header/path/request-data) with no `authorizeTenantAccess` means the
    // package serves whatever tenant id the caller supplies. Warn once at boot
    // unless the host explicitly accepted the risk via acknowledgeNoMembershipGate.
    // The same verdict backs the `membership_gate` doctor check. Logger comes
    // from the container (the eager logger binding is undefined this early in boot).
    const idorWarning = membershipGateRisk(config)
    const hostTrust = hostTrustWarning(config)
    if (idorWarning || hostTrust) {
      const bootLogger = await this.app.container.make('logger').catch(() => undefined)
      // assertConfigBounds already hard-failed the host-trust case in production,
      // so reaching here with hostTrust set means a non-production boot.
      if (idorWarning) bootLogger?.warn(idorWarning)
      if (hostTrust) bootLogger?.warn(hostTrust)
    }

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

    await this.#registerQueueJobs()
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
      // Container-resolved on purpose: this runs during boot(), before the
      // eager `@adonisjs/core/services/logger` binding exists (see the
      // rowscope warning above for the same constraint).
      const bootLogger = await this.app.container.make('logger').catch(() => undefined)
      bootLogger?.warn(
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
   * When the opt-in tenant-resolution cache is enabled, drop a tenant's cached
   * entry the moment a lifecycle event changes its status in-process, so a
   * suspend / maintenance / delete takes effect immediately on this pod instead
   * of waiting out the TTL. (Cross-pod propagation stays bounded by the TTL —
   * documented on the config.) No-op when the cache is off.
   *
   * Wired in `ready()`, NOT `boot()`: the emitter is only fully constructed once
   * the app is booted, so resolving it during boot() returns an unwired emitter
   * and silently drops every subscription. `ready()` runs after the booted
   * hooks (the same lifecycle the satellite providers use for listeners), and
   * the emitter comes from the container — never the `services/emitter` module,
   * which resolves to `undefined` mid-boot. It is resolved defensively so a
   * stripped-down container without an emitter can't break startup.
   */
  async ready() {
    const config = this.app.config.get<MultitenancyConfig>('multitenancy')
    if (!config.resolver?.cache?.enabled) return
    const emitter = await this.app.container.make('emitter').catch(() => null)
    if (!emitter) return
    const cache = await this.app.container.make(TenantResolutionCache)
    wireResolutionCacheInvalidation(emitter, cache)
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
