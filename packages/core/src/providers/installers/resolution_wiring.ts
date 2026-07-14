import { wireResolverChain } from '../resolver_chain.js'
import { setResolverRegistry } from '../../extensions/request.js'
import { resolutionSafetyAudit } from '../resolution_safety.js'
import { wireResolutionCacheInvalidation } from '../resolution_cache_invalidation.js'
import TenantResolverRegistry from '../../services/resolvers/registry.js'
import TenantResolutionCache from '../../services/tenant_resolution_cache.js'
import CrossDomainRedirectService from '../../services/cross_domain_redirect_service.js'
import type { MultitenancyConfig } from '../../types/config.js'
import type { InstallerContext, ProviderInstaller } from './installer.js'

/**
 * Tenant resolution: the resolver registry + chain seeding, the request-path sync
 * cache, canonical-domain redirects, and the opt-in resolution-cache invalidation.
 */
export const resolutionWiring: ProviderInstaller = {
  name: 'resolution',

  register(ctx: InstallerContext): void {
    ctx.app.container.singleton(TenantResolverRegistry, () => new TenantResolverRegistry())
    ctx.app.container.singleton(TenantResolutionCache, () => new TenantResolutionCache())
    ctx.app.container.singleton(CrossDomainRedirectService, () => new CrossDomainRedirectService())
  },

  async boot(ctx: InstallerContext): Promise<void> {
    const { app } = ctx
    const config = app.config.get<MultitenancyConfig>('multitenancy')

    // Resolve the resolver registry singleton. Its contents (the chain) are seeded
    // just below and read lazily per query, so the seed order relative to the
    // adapter (constructed in IsolationWiring) is not load-bearing.
    const resolvers = await app.container.make(TenantResolverRegistry)

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
      ctx.warnWhenBooted((logger) => {
        for (const risk of resolutionRisks) logger.warn(risk.message)
      })
    }
  },

  /**
   * When the opt-in tenant-resolution cache is enabled, drop a tenant's cached
   * entry the moment a lifecycle event changes its status in-process, so a
   * suspend / maintenance / delete takes effect immediately on this pod instead
   * of waiting out the TTL. No-op when the cache is off.
   *
   * Wired in `ready()`, NOT `boot()`: the emitter is only fully constructed once
   * the app is booted, so resolving it during boot() returns an unwired emitter
   * and silently drops every subscription. `ready()` runs after the booted
   * hooks, and the emitter comes from the container, never the `services/emitter`
   * module, which resolves to `undefined` mid-boot. It is resolved defensively so
   * a stripped-down container without an emitter can't break startup. The teardown
   * is captured via `ctx.addDisposer` so shutdown() removes these lifecycle
   * listeners again — without it a ready()/shutdown() cycle (repeated boots in one
   * process) leaks one listener set per cycle and the emitter's listener count
   * climbs unbounded.
   */
  async ready(ctx: InstallerContext): Promise<void> {
    const { app } = ctx
    const config = app.config.get<MultitenancyConfig>('multitenancy')
    if (!config.resolver?.cache?.enabled) return
    const emitter = await app.container.make('emitter').catch(() => null)
    if (!emitter) return
    const cache = await app.container.make(TenantResolutionCache)
    ctx.addDisposer(wireResolutionCacheInvalidation(emitter, cache))
  },
}
