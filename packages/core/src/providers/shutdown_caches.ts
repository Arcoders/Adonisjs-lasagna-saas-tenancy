/**
 * Invalidate the module-level caches that hold references to container
 * singletons. `MultitenancyProvider.shutdown()` delegates here; the logic
 * lives in its own module (with no service imports in its graph) so the
 * regression spec can exercise it without booting an Ignitor.
 *
 * Without this, the next `tenancy.run()` (or any code that called
 * `getActiveDriver()`) keeps a reference to the old, now-dead
 * `TenantLogContext` / `IsolationDriverRegistry` instances, leading to
 * stale-state surprises in test runs that reuse the container or in
 * production hot-reload paths.
 */
export async function resetModuleCaches(): Promise<void> {
  const [{ __configureTenancyForTests }, { __resetActiveDriverCache }] = await Promise.all([
    import('../tenancy.js'),
    import('../services/isolation/active_driver.js'),
  ])
  __configureTenancyForTests({})
  __resetActiveDriverCache()
}
