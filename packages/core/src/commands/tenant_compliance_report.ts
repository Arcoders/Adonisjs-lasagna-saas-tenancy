import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import ComplianceReportService from '../services/compliance/compliance_report_service.js'
import type { ComplianceReport, ControlStatus } from '../services/compliance/types.js'

const STATUS_COLOR: Record<ControlStatus, 'green' | 'yellow' | 'cyan'> = {
  'satisfied': 'green',
  'action-needed': 'yellow',
  'info': 'cyan',
}

/**
 * Report compliance posture by introspecting config + database state. The control
 * set is a registry (like tenant:doctor's checks) so satellites can contribute
 * their own controls. NOT a certification — it shows which controls Lasagna
 * gives you evidence for and what stays the host's job.
 */
export default class TenantComplianceReport extends BaseCommand {
  static readonly commandName = 'tenant:compliance:report'
  static readonly description =
    'Report compliance posture (SOC2/GDPR/ISO/HIPAA controls) by introspecting config and database state'
  static readonly options: CommandOptions = { startApp: true }

  @flags.string({
    flagName: 'framework',
    default: 'all',
    description: 'Filter controls by framework: soc2 | gdpr | iso | hipaa | all',
  })
  declare framework: string

  @flags.array({
    flagName: 'control',
    description: 'Run only the named control(s); pass --control=list to print available controls',
  })
  declare control?: string[]

  @flags.boolean({
    flagName: 'json',
    default: false,
    description: 'Emit a JSON report on stdout instead of the table',
  })
  declare json: boolean

  @flags.boolean({
    flagName: 'strict',
    default: false,
    description: 'Exit 1 when any control reports action-needed (for CI gating)',
  })
  declare strict: boolean

  async run() {
    const service = await app.container.make(ComplianceReportService)

    if (this.control?.includes('list')) {
      const table = this.ui.table()
      table.head(['Control', 'Frameworks'])
      for (const c of service.list()) table.row([c.id, c.frameworks.join(', ')])
      table.render()
      return
    }

    const report = await service.run({ framework: this.framework, controls: this.control })

    if (this.json) {
      this.logger.log(JSON.stringify(report, null, 2))
    } else {
      this.#render(report)
    }

    this.exitCode = this.strict && report.totals.actionNeeded > 0 ? 1 : 0
  }

  #render(report: ComplianceReport) {
    if (report.controls.length === 0) {
      this.logger.info('No controls match the given filter.')
      return
    }

    this.logger.log('')
    this.logger.log(
      this.colors.dim(
        'This is NOT a certification. Certification is earned by the organization that ' +
          'deploys the software — this report shows the controls Lasagna gives you evidence for.'
      )
    )

    for (const control of report.controls) {
      const tag = this.colors[STATUS_COLOR[control.status]](`[${control.status.toUpperCase()}]`)
      this.logger.log('')
      this.logger.log(
        `${this.colors.bold(`▸ ${control.title}`)}  ${this.colors.dim(control.frameworks.join(', '))}`
      )
      this.logger.log(`  ${tag} ${control.evidence}`)
      this.logger.log(`  ${this.colors.dim('host:')} ${control.hostResponsibility}`)
      if (control.remediation) {
        this.logger.log(`  ${this.colors.dim('fix:')}  ${control.remediation}`)
      }
    }

    this.logger.log('')
    this.logger.log(
      this.colors.bold('Totals  ') +
        `${this.colors.green(`satisfied: ${report.totals.satisfied}`)}  ` +
        `${this.colors.yellow(`action-needed: ${report.totals.actionNeeded}`)}  ` +
        `${this.colors.cyan(`info: ${report.totals.info}`)}`
    )
  }
}
