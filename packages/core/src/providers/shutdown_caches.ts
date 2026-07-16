/**
 * Invalidate the module-level caches that hold references to container
 * singletons. `MultitenancyProvider.shutdown()` delegates here; the logic
 * lives in its own module (no static service imports of its own) so the
 * regression spec can exercise it without booting an Ignitor.
 *
 * Without this, the next `tenancy.run()`, `getActiveDriver()`, or
 * `request.tenant()` keeps a reference to the old, now-dead `TenantLogContext`,
 * `IsolationDriverRegistry`, resolver registry, or resolution-cache instance,
 * leading to stale-state surprises in test runs that reuse the container or in
 * production hot-reload paths. Every module that memoizes such a reference must
 * be reset here. Leaving one out is exactly the kind of footgun this function
 * exists to prevent.
 */
export async function resetModuleCaches(): Promise<void> {
  const [
    { __configureTenancyForTests },
    { __resetActiveDriverCache },
    { __resetResolverRegistryCacheForTests, __resetResolutionCacheRefForTests },
  ] = await Promise.all([
    import('../tenancy.js'),
    import('../services/isolation/active_driver.js'),
    import('../extensions/request.js'),
  ])
  __configureTenancyForTests({})
  __resetActiveDriverCache()
  __resetResolverRegistryCacheForTests()
  __resetResolutionCacheRefForTests()
}
