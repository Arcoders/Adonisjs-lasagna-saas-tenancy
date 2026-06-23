import type { ApplicationService } from '@adonisjs/core/types'
import type {
  SatelliteProviderConstructor,
  SatelliteProviderContract,
} from '@adonisjs-lasagna/saas-tenancy/sdk'
import ReportingService from '../src/reporting_service.js'

/**
 * Provider for `@adonisjs-lasagna/reporting`. Register it in the host's
 * `adonisrc.ts` alongside the core `MultitenancyProvider` (the configure hook
 * does this for you).
 *
 * Reporting is read-only and backoffice-scoped, so it owns no tenant-lifecycle
 * hooks — it only binds its service singleton. Core is resolved through the
 * container, never `new`-ed; the dependency only goes satellite → core.
 */
export default class ReportingProvider implements SatelliteProviderContract {
  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton(ReportingService, () => new ReportingService())
  }
}

// Compile-time ABI pin: fail the build if the provider drifts from the public
// satellite constructor contract (same guard billing/backup use).
const _satelliteAbiPin: SatelliteProviderConstructor = ReportingProvider
void _satelliteAbiPin
