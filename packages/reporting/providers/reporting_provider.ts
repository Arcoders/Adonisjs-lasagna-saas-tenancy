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
}

// Compile-time ABI pin: fail the build if the provider drifts from the public
// satellite constructor contract (same guard billing/backup use).
const _satelliteAbiPin: SatelliteProviderConstructor = ReportingProvider
void _satelliteAbiPin
