import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { getConfig } from '../config.js'
import { discoverSatellites } from '../sdk/configure_kit.js'
import { trustedSatellites } from '../sdk/plugin_env.js'
import PluginDoctorService from '../services/plugin_doctor_service.js'
import type { DiagnosisSeverity } from '../services/doctor/types.js'

const SEVERITY_COLOR: Record<DiagnosisSeverity, 'cyan' | 'yellow' | 'red'> = {
  info: 'cyan',
  warn: 'yellow',
  error: 'red',
}

/**
 * `plugin:doctor` diagnoses the installed plugin/satellite PLATFORM posture.
 * It reads the discovered satellite manifests plus the runtime trust and firewall
 * configuration and reports ABI drift, native-addon sandbox risk, a stale
 * `TRUSTED_SATELLITES` allowlist, a missing read-only firewall, and which plugins
 * hold declared (consent-gated) permissions. The checking logic is the pure `PluginDoctorService`;
 * this command is the thin shell that gathers the input and renders the report.
 *
 * It does NOT re-check whether the manifest and spec agree. That is the
 * `check-plugin-permissions` CI guard's job (the specs are not available at runtime).
 * Exit code 1 on any error.
 */
export default class PluginDoctor extends BaseCommand {
  static readonly commandName = 'plugin:doctor'
  static readonly description =
    'Diagnose the installed plugin/satellite platform posture — ABI compatibility, ' +
    'native-addon sandbox risk, the TRUSTED_SATELLITES allowlist, and the read-only firewall'
  static readonly options: CommandOptions = { startApp: true }

  @flags.boolean({
    flagName: 'json',
    default: false,
    description: 'Emit a JSON report on stdout instead of the table',
  })
  declare json: boolean

  async run() {
    const root = this.app.makePath()
    const discovered = await discoverSatellites(root, (m) => this.logger.warning(m))
    const config = getConfig()

    const report = new PluginDoctorService().run({
      satellites: discovered.map((s) => ({
        packageName: s.packageName,
        name: s.manifest.name,
        satelliteApi: s.manifest.satelliteApi,
        permissions: s.manifest.permissions,
        nativeAddons: s.manifest.nativeAddons,
      })),
      trusted: trustedSatellites(),
      readOnlyConfigured: config.plugins?.readOnly !== undefined,
    })

    if (this.json) {
      this.logger.log(JSON.stringify(report, null, 2))
      this.exitCode = report.totals.error > 0 ? 1 : 0
      return
    }

    this.logger.info(`${discovered.length} installed satellite(s) discovered`)
    for (const issue of report.issues) {
      const tag = this.colors[SEVERITY_COLOR[issue.severity]](`[${issue.severity.toUpperCase()}]`)
      this.logger.log(`  ${tag} ${issue.message}`)
    }
    this.logger.log('')
    this.logger.log(
      this.colors.bold('Summary  ') +
        `info: ${report.totals.info}  ` +
        this.colors.yellow(`warn: ${report.totals.warn}`) +
        '  ' +
        this.colors.red(`error: ${report.totals.error}`)
    )
    this.exitCode = report.totals.error > 0 ? 1 : 0
  }
}
