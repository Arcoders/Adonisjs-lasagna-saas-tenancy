import { Database } from '@adonisjs/lucid/database'
import { getConfig } from '../../config.js'
import {
  assertRowScopeRlsPresent,
  assertRowScopeTablesDeclared,
  probeRlsCatalog,
} from '../../services/isolation/rls_boot_probe.js'
import type { MultitenancyConfig } from '../../types/config.js'
import { TenantAdapter } from '../../models/adapters/index.js'
import { BackofficeBaseModel, TenantBaseModel, CentralBaseModel } from '../../models/base/index.js'
import IsolationDriverRegistry from '../../services/isolation/registry.js'
import { assertConfiguredDriverRegistered } from '../../services/isolation/validate_driver_choice.js'
import { BUILT_IN_ISOLATION_DRIVERS } from '../../services/isolation/built_in_drivers.js'
import TenantResolverRegistry from '../../services/resolvers/registry.js'
import WarmPoolService from '../../services/isolation/warm_pool_service.js'
import { probePgBouncerAtBoot } from '../../services/isolation/pgbouncer_probe.js'
import type { InstallerContext, ProviderInstaller } from './installer.js'

/**
 * Isolation: the driver registry, the built-in driver registration + posture
 * checks, and the unified adapter that binds the three base models to their
 * routing. Owns adapter construction because its hard dependency is the driver
 * set (the enforced schema/connection selection); the resolver registry is a soft
 * dependency it reads lazily per query and only needs the registry OBJECT (present
 * at register), so there is no boot-order coupling to ResolutionWiring.
 */
export const isolationWiring: ProviderInstaller = {
  name: 'isolation',

  register(ctx: InstallerContext): void {
    ctx.app.container.singleton(IsolationDriverRegistry, () => new IsolationDriverRegistry())
    // F2 — the connection warm pool is a stateless, container-resolved service so
    // it can be resolved from ready() (and from a test) rather than new-ed ad hoc.
    ctx.app.container.singleton(WarmPoolService, () => new WarmPoolService())
  },

  async boot(ctx: InstallerContext): Promise<void> {
    const { app } = ctx
    const config = app.config.get<MultitenancyConfig>('multitenancy')

    BackofficeBaseModel.connection = config.backofficeConnectionName
    CentralBaseModel.connection = config.centralConnectionName

    const db = await app.container.make(Database)
    const drivers = await app.container.make(IsolationDriverRegistry)

    // Register the configured isolation driver into the registry made above.
    // The adapter reads the registry lazily on each query, so registering the
    // driver before the adapter is wired below is a convenience rather than a
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
      ctx.warnWhenBooted((logger) =>
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
    // ABOVE the soft cap. Set BELOW maxTenantConnections it breaks the pool: new
    // tenants are refused (503) before the size ever exceeds the cap, so the
    // in-use-aware LRU never runs to shed idle connections, and requests are
    // refused while evictable connections sit open. Deferred to app.booted for the
    // logger, like the rowscope hint above.
    if (choice === 'schema-pg' || choice === 'database-pg') {
      const iso = getConfig().isolation
      const ceiling = iso.maxTenantConnectionsHardCeiling
      if (ceiling !== undefined && ceiling < iso.maxTenantConnections) {
        ctx.warnWhenBooted((logger) =>
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

    // One unified adapter for all three base models. It routes by each model's
    // declarative `static isolation` marker (tenant / backoffice / central)
    // rather than by which adapter subclass was attached, so the base classes
    // are thin shims that just set the marker (see models/base/isolation_kind).
    // Its resolver-registry dependency is the singleton OBJECT (present since
    // register()), consumed lazily per query, so constructing it here, before
    // ResolutionWiring seeds the chain, is safe (documented convenience).
    const resolvers = await app.container.make(TenantResolverRegistry)
    const unifiedAdapter = new TenantAdapter(db, drivers, resolvers)
    TenantBaseModel.$adapter = unifiedAdapter
    BackofficeBaseModel.$adapter = unifiedAdapter
    CentralBaseModel.$adapter = unifiedAdapter
  },

  async start(ctx: InstallerContext): Promise<void> {
    const config = ctx.app.config.get<MultitenancyConfig>('multitenancy')

    // Every provider's boot() has run by now, so a custom driver registered
    // by the host is visible. A typo'd built-in name compiles (the choice
    // type is open for custom drivers), so catch it here, at boot, instead of
    // letting the first tenant query fail with a generic "no active driver".
    const drivers = await ctx.app.container.make(IsolationDriverRegistry)
    assertConfiguredDriverRegistered(drivers, config.isolation?.driver ?? 'schema-pg')
  },

  ready(ctx: InstallerContext): void {
    const config = ctx.app.config.get<MultitenancyConfig>('multitenancy')
    const iso = config.isolation

    // F3 — probe for a PgBouncer front once the DB is up. Fail-closed: the probe
    // logs its finding and never raises a cap or breaks boot.
    if (iso?.pgBouncer && iso.pgBouncer.mode !== 'off') {
      void ctx.app.booted(async () => {
        try {
          await probePgBouncerAtBoot()
        } catch {
          // A detection probe must never fail app startup; the probe already
          // logs and degrades internally, this only guards a pathological throw.
        }
      })
    }

    // F2 — warm the operator-declared hot tenants once the app is fully booted, so
    // warming never blocks boot and the container logger exists. WarmPoolService
    // fails closed per tenant, so nothing here can break startup.
    if (iso?.warmPool?.enabled) {
      void ctx.app.booted(async () => {
        try {
          const warmPool = await ctx.app.container.make(WarmPoolService)
          await warmPool.warmAll()
        } catch {
          // WarmPoolService.warmAll never throws; this only guards a pathological
          // container.make failure so warming can never take boot down.
        }
      })
    }
  },
}
