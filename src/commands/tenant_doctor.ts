import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import DoctorService from '../services/doctor/doctor_service.js'
import type { DiagnosisSeverity, DoctorRunResult } from '../services/doctor/types.js'

const SEVERITY_COLOR: Record<DiagnosisSeverity, 'cyan' | 'yellow' | 'red'> = {
  info: 'cyan',
  warn: 'yellow',
  error: 'red',
}

const ANSI_CLEAR = '\x1b[2J\x1b[H'
const ANSI_REGEX = /\x1b\[[0-9;]*m/g
const MIN_WATCH_INTERVAL_MS = 1000
const DEFAULT_WATCH_INTERVAL_MS = 5000

function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '')
}

export default class TenantDoctor extends BaseCommand {
  static readonly commandName = 'tenant:doctor'
  static readonly description =
    'Diagnose tenancy state — schema drift, migrations, circuits, queues, backups, stalled provisioning, failed tenants'
  static readonly options: CommandOptions = { startApp: true }

  @flags.array({
    alias: 't',
    flagName: 'tenant',
    description: 'Limit checks to one or more tenant IDs',
  })
  declare tenant?: string[]

  @flags.array({
    flagName: 'check',
    description: 'Run only the named check(s); pass --check=list to print available checks',
  })
  declare check?: string[]

  @flags.boolean({
    flagName: 'fix',
    default: false,
    description: 'Apply auto-fix for fixable issues (circuit reset, mark stalled tenants as failed)',
  })
  declare fix: boolean

  @flags.boolean({
    flagName: 'json',
    default: false,
    description: 'Emit a JSON report on stdout instead of the table',
  })
  declare json: boolean

  @flags.boolean({
    flagName: 'watch',
    alias: 'w',
    default: false,
    description: 'Re-run continuously and redraw a compact dashboard every --interval ms',
  })
  declare watch: boolean

  @flags.number({
    flagName: 'interval',
    description: `Refresh interval in ms when --watch is set (default ${DEFAULT_WATCH_INTERVAL_MS}, min ${MIN_WATCH_INTERVAL_MS})`,
  })
  declare interval?: number

  async run() {
    const doctor = await app.container.make(DoctorService)

    if (this.check?.includes('list')) {
      this.#printCheckList(doctor)
      return
    }

    if (this.watch) {
      await this.#runWatch(doctor)
      return
    }

    const result = await doctor.run({
      tenants: this.tenant,
      checks: this.check,
      fix: this.fix,
    })

    if (this.json) {
      this.logger.log(JSON.stringify(result, null, 2))
      this.exitCode = result.totals.error > 0 ? 1 : 0
      return
    }

    this.#renderReports(result)
    this.exitCode = result.totals.error > 0 ? 1 : 0
  }

  async #runWatch(doctor: DoctorService) {
    if (this.fix) {
      this.logger.warning('--fix is ignored in --watch mode (no auto-fixes inside a polling loop).')
    }
    if (this.json) {
      this.logger.warning('--json is ignored in --watch mode.')
    }

    const intervalMs = Math.max(
      MIN_WATCH_INTERVAL_MS,
      this.interval ?? DEFAULT_WATCH_INTERVAL_MS
    )

    let stop = false
    const onSigint = () => {
      stop = true
    }
    process.on('SIGINT', onSigint)

    try {
      while (!stop) {
        const start = Date.now()
        const result = await doctor.run({
          tenants: this.tenant,
          checks: this.check,
          fix: false,
        })
        if (stop) break
        const totalMs = Date.now() - start
        this.#renderWatch(result, intervalMs, totalMs)

        const remaining = intervalMs - totalMs
        if (remaining > 0) await this.#sleep(remaining, () => stop)
      }
    } finally {
      process.off('SIGINT', onSigint)
      process.stdout.write('\n')
      this.logger.info('Stopped watch mode.')
    }
  }

  #sleep(ms: number, isCancelled: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      const start = Date.now()
      const tick = () => {
        if (isCancelled() || Date.now() - start >= ms) return resolve()
        setTimeout(tick, Math.min(100, ms - (Date.now() - start)))
      }
      tick()
    })
  }

  #renderWatch(result: DoctorRunResult, intervalMs: number, runMs: number) {
    process.stdout.write(ANSI_CLEAR)

    const now = new Date().toISOString().replace('T', ' ').replace(/\..+/, '')
    const { totals } = result
    const headline =
      `${this.colors.bold('tenant:doctor --watch')}  ` +
      this.colors.dim(`${now}  ·  every ${intervalMs}ms  ·  Ctrl+C to exit`)
    this.logger.log(headline)
    this.logger.log(
      this.colors.dim(
        `Last run took ${runMs}ms — ${result.reports.length} check(s)`
      )
    )
    this.logger.log('')

    const rows: string[][] = []
    for (const report of result.reports) {
      if (report.error) {
        rows.push([
          this.colors.red('THROW'),
          report.check,
          '—',
          `${report.durationMs}ms`,
          report.error,
        ])
        continue
      }

      if (report.issues.length === 0) {
        rows.push([
          this.colors.green('OK'),
          report.check,
          '0',
          `${report.durationMs}ms`,
          '',
        ])
        continue
      }

      const errors = report.issues.filter((i) => i.severity === 'error').length
      const warns = report.issues.filter((i) => i.severity === 'warn').length
      const infos = report.issues.filter((i) => i.severity === 'info').length

      const tag =
        errors > 0
          ? this.colors.red('FAIL')
          : warns > 0
            ? this.colors.yellow('WARN')
            : this.colors.cyan('INFO')

      const counts =
        [
          errors > 0 ? this.colors.red(`${errors}E`) : '',
          warns > 0 ? this.colors.yellow(`${warns}W`) : '',
          infos > 0 ? this.colors.cyan(`${infos}I`) : '',
        ]
          .filter(Boolean)
          .join(' ') || '0'

      const firstIssue = report.issues[0]
      const idTag = firstIssue.tenantId ? `${firstIssue.tenantId.slice(0, 8)}… ` : ''
      const sample = `${idTag}${firstIssue.message}`.slice(0, 80)

      rows.push([tag, report.check, counts, `${report.durationMs}ms`, sample])
    }

    const widths = [
      Math.max(...rows.map((r) => stripAnsi(r[0]).length), 6),
      Math.max(...rows.map((r) => r[1].length), 12),
      Math.max(...rows.map((r) => stripAnsi(r[2]).length), 6),
      Math.max(...rows.map((r) => r[3].length), 6),
    ]
    for (const r of rows) {
      const c0 = r[0] + ' '.repeat(Math.max(0, widths[0] - stripAnsi(r[0]).length))
      const c1 = r[1].padEnd(widths[1])
      const c2 = r[2] + ' '.repeat(Math.max(0, widths[2] - stripAnsi(r[2]).length))
      const c3 = r[3].padEnd(widths[3])
      this.logger.log(`  ${c0}  ${this.colors.bold(c1)}  ${c2}  ${this.colors.dim(c3)}  ${this.colors.dim(r[4])}`)
    }

    this.logger.log('')
    this.logger.log(
      this.colors.bold('Totals  ') +
        `info: ${totals.info}  ` +
        this.colors.yellow(`warn: ${totals.warn}`) + '  ' +
        this.colors.red(`error: ${totals.error}`) + '  ' +
        this.colors.dim(`fixable: ${totals.fixable}`)
    )
  }

  #printCheckList(doctor: DoctorService) {
    const table = this.ui.table()
    table.head(['Name', 'Description'])
    for (const c of doctor.list()) table.row([c.name, c.description])
    table.render()
  }

  #renderReports(result: { reports: any[]; totals: any }) {
    const { reports, totals } = result
    if (reports.length === 0) {
      this.logger.info('No checks registered.')
      return
    }

    for (const report of reports) {
      this.logger.log('')
      this.logger.log(this.colors.bold(`▸ ${report.check}`) + this.colors.dim(`  (${report.durationMs}ms)`))

      if (report.error) {
        this.logger.log('  ' + this.colors.red(`Check threw: ${report.error}`))
        continue
      }

      if (report.issues.length === 0) {
        this.logger.log('  ' + this.colors.green('OK'))
        continue
      }

      for (const issue of report.issues) {
        const tag = this.colors[SEVERITY_COLOR[issue.severity as DiagnosisSeverity]](
          `[${issue.severity.toUpperCase()}]`
        )
        const fixed =
          issue.meta && (issue.meta as any).fixed === true
            ? ' ' + this.colors.green('(fixed)')
            : issue.fixable
              ? ' ' + this.colors.dim('(fixable; pass --fix)')
              : ''
        const idTag = issue.tenantId ? this.colors.dim(` ${issue.tenantId}`) : ''
        this.logger.log(`  ${tag}${idTag} ${issue.message}${fixed}`)
      }
    }

    this.logger.log('')
    const summary =
      `info: ${totals.info}  ` +
      `${this.colors.yellow(`warn: ${totals.warn}`)}  ` +
      `${this.colors.red(`error: ${totals.error}`)}  ` +
      `fixable: ${totals.fixable}`
    this.logger.log(this.colors.bold('Summary  ') + summary)

    if (!this.fix && totals.fixable > 0) {
      this.logger.log(this.colors.dim(`Re-run with --fix to apply auto-fixes.`))
    }
  }
}
