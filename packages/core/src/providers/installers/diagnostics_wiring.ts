import HealthService from '../../health/health_service.js'
import { registerDefaultChecks } from '../../health/default_checks.js'
import DoctorService from '../../services/doctor/doctor_service.js'
import { builtInChecks } from '../../services/doctor/checks/index.js'
import ComplianceReportService from '../../services/compliance/compliance_report_service.js'
import { builtInControls } from '../../services/compliance/controls/index.js'
import type { InstallerContext, ProviderInstaller } from './installer.js'

/**
 * Read/inspect plane: the readiness health service, the preflight doctor, and the
 * compliance reporter. The Doctor/Compliance factories eagerly register their
 * built-in checks/controls inside the closure — that runs at first `make()`, not
 * at register().
 */
export const diagnosticsWiring: ProviderInstaller = {
  name: 'diagnostics',

  register(ctx: InstallerContext): void {
    ctx.app.container.singleton(HealthService, () => new HealthService())
    ctx.app.container.singleton(DoctorService, () => {
      const svc = new DoctorService()
      for (const check of builtInChecks) svc.register(check)
      return svc
    })
    ctx.app.container.singleton(ComplianceReportService, () => {
      const svc = new ComplianceReportService()
      for (const control of builtInControls) svc.register(control)
      return svc
    })
  },

  async boot(ctx: InstallerContext): Promise<void> {
    // Default readiness checks live on the singleton from boot onward.
    // Host providers boot after this one, so their addCheck/removeCheck
    // calls override the defaults deterministically, and the controller never
    // re-registers anything at probe time.
    registerDefaultChecks(await ctx.app.container.make(HealthService))
  },
}
