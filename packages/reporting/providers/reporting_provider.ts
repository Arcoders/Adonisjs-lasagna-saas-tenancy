import { definePlugin, LASAGNA_PLUGIN_API_VERSION } from '@adonisjs-lasagna/saas-tenancy/plugin'
import ReportingService from '../src/reporting_service.js'
import ReportExtensionRegistry from '../src/report_extension_registry.js'
import {
  assertReportingConfig,
  type MultitenancyConfigWithReporting,
} from '../src/validate_config.js'

/**
 * Provider for `@adonisjs-lasagna/reporting`, built with the {@link definePlugin}
 * facade. Register it in the host's `adonisrc.ts` alongside the core
 * `MultitenancyProvider` (the configure hook does this for you).
 *
 * The facade wires the ABI backstops (the Satellite ABI + the facade-contract
 * version) inside its own `boot()`, so this file declares only what reporting
 * actually does. Reporting is read-only and backoffice-scoped: it owns no
 * tenant-lifecycle hooks and no request-path seams, so it uses no Lote A section,
 * just the lifecycle hooks. Core is resolved through the container, never `new`-ed;
 * the dependency only goes from satellite to core.
 */
export default definePlugin({
  name: 'reporting',
  packageName: '@adonisjs-lasagna/reporting',
  // Mirrors package.json#lasagnaSatellite.satelliteApi (check-abi-boot-assertion
  // pins these two against each other so the literal can't drift).
  satelliteApi: 1,
  // The definePlugin facade contract this satellite was built against.
  pluginApiVersion: LASAGNA_PLUGIN_API_VERSION,

  // register(): bind the service + the report-extension registry singletons.
  bind(app) {
    app.container.singleton(ReportingService, () => new ReportingService())
    app.container.singleton(ReportExtensionRegistry, () => new ReportExtensionRegistry())
  },

  // boot(): validate the optional `reporting` config block so a bad shape fails at
  // startup. The ABI backstops already ran (inside the facade) before this hook.
  boot(app) {
    const config = app.config.get<MultitenancyConfigWithReporting>('multitenancy')
    assertReportingConfig(config?.reporting)
  },

  /**
   * `ready` runs after `boot`, so the emitter (which resolves via `app.booted()`)
   * is guaranteed to exist. Wiring it in `boot()` would race that and silently
   * skip the subscription.
   *
   * When `config.reporting.cache.invalidateOnFlush` is set, clear the GLOBAL
   * `reporting` dashboard cache on every `MetricsFlushed` event, so a cached
   * dashboard refreshes the moment `tenant:metrics:flush` lands. Off by default
   * (pair it with `cacheTtlMs > 0`). Always the global namespace, never a tenant
   * scope. (A surgical `.delete(key)` can't cover the rolling-window key space a
   * flush touches, so we clear the whole namespace.) `.clear()` is best-effort.
   */
  async ready(app) {
    const config = app.config.get<MultitenancyConfigWithReporting>('multitenancy')
    if (!config?.reporting?.cache?.invalidateOnFlush) return
    const emitter = await app.container.make('emitter')
    const { MetricsFlushed } = await import('@adonisjs-lasagna/saas-tenancy/events')
    const { getCache } = await import('@adonisjs-lasagna/saas-tenancy/services')
    emitter.on(MetricsFlushed, () => {
      try {
        void getCache()
          .namespace('reporting')
          .clear()
          .catch(() => {})
      } catch {
        // best-effort: never let cache invalidation break the emitter
      }
    })
  },
})
