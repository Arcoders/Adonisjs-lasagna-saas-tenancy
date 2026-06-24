import type { ApplicationService } from '@adonisjs/core/types'
import type {
  SatelliteProviderConstructor,
  SatelliteProviderContract,
} from '@adonisjs-lasagna/saas-tenancy/sdk'
import ReportingService from '../src/reporting_service.js'
import ReportExtensionRegistry from '../src/report_extension_registry.js'
import {
  assertReportingConfig,
  type MultitenancyConfigWithReporting,
} from '../src/validate_config.js'

/**
 * Provider for `@adonisjs-lasagna/reporting`. Register it in the host's
 * `adonisrc.ts` alongside the core `MultitenancyProvider` (the configure hook
 * does this for you).
 *
 * Reporting is read-only and backoffice-scoped, so it owns no tenant-lifecycle
 * hooks. It binds its service + the report-extension registry singletons in
 * `register()`, and validates the optional `reporting` config block in `boot()`
 * so a bad shape fails at startup. Core is resolved through the container, never
 * `new`-ed; the dependency only goes satellite → core.
 */
export default class ReportingProvider implements SatelliteProviderContract {
  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton(ReportingService, () => new ReportingService())
    this.app.container.singleton(ReportExtensionRegistry, () => new ReportExtensionRegistry())
  }

  boot() {
    const config = this.app.config.get<MultitenancyConfigWithReporting>('multitenancy')
    assertReportingConfig(config?.reporting)
  }

  /**
   * `ready` runs after `boot`, so the emitter (which resolves via `app.booted()`)
   * is guaranteed to exist — wiring it in `boot()` would race that and silently
   * skip the subscription. Same lifecycle the demo app provider uses for listeners.
   */
  async ready() {
    const config = this.app.config.get<MultitenancyConfigWithReporting>('multitenancy')
    await this.#wireFlushCacheInvalidation(config)
  }

  /**
   * When `config.reporting.cache.invalidateOnFlush` is set, clear the global
   * `reporting` dashboard cache on every `MetricsFlushed` event, so a cached
   * dashboard refreshes the moment `tenant:metrics:flush` lands. Off by default
   * (pair it with `cacheTtlMs > 0`). Always the GLOBAL namespace — never a tenant
   * scope. (A surgical `.delete(key)` can't cover the rolling-window key space a
   * flush touches, so we clear the whole namespace.) `.clear()` is best-effort.
   */
  async #wireFlushCacheInvalidation(config?: MultitenancyConfigWithReporting): Promise<void> {
    if (!config?.reporting?.cache?.invalidateOnFlush) return
    const emitter = await this.app.container.make('emitter')
    const { MetricsFlushed } = await import('@adonisjs-lasagna/saas-tenancy/events')
    const { getCache } = await import('@adonisjs-lasagna/saas-tenancy/services')
    emitter.on(MetricsFlushed, () => {
      try {
        void getCache()
          .namespace('reporting')
          .clear()
          .catch(() => {})
      } catch {
        // best-effort — never let cache invalidation break the emitter
      }
    })
  }
}

// Compile-time ABI pin: fail the build if the provider drifts from the public
// satellite constructor contract (same guard billing/backup use).
const _satelliteAbiPin: SatelliteProviderConstructor = ReportingProvider
void _satelliteAbiPin
