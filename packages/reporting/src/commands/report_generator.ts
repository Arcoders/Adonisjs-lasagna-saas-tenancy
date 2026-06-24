import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { writeFileSync } from 'node:fs'
import ReportingService from '../reporting_service.js'
import ReportExtensionRegistry from '../report_extension_registry.js'
import { formatReport, isReportFormat, type ReportFormat } from '../format.js'
import type { ReportPeriod } from '../types.js'

/**
 * Print (or write) a cross-tenant usage report — handy for ops spot-checks, a
 * scheduled summary, or verifying the metrics pipeline. With `--extension` it
 * runs a host-registered report extension instead of the built-in report.
 */
export default class ReportGenerator extends BaseCommand {
  static commandName = 'tenant:report:generate'
  static description = 'Generate and print a cross-tenant usage report'
  static options: CommandOptions = { startApp: true }

  @flags.string({ description: 'Aggregation period: day | week | month', default: 'day' })
  declare period: string

  @flags.string({ description: 'Start date (ISO YYYY-MM-DD). Default: 30 days ago' })
  declare since?: string

  @flags.string({ description: 'End date (ISO YYYY-MM-DD). Default: today' })
  declare until?: string

  @flags.number({ description: 'Top N tenants to list', default: 10 })
  declare top: number

  @flags.string({ description: 'Output format: table | json | csv', default: 'table' })
  declare format: string

  @flags.string({ description: 'Write output to a file instead of stdout' })
  declare out?: string

  @flags.string({
    description: 'Run a registered report extension by name instead of the built-in report',
  })
  declare extension?: string

  async run(): Promise<void> {
    const output = this.extension ? await this.#runExtension() : await this.#runReport()

    if (this.out) {
      writeFileSync(this.out, output, 'utf8')
      this.logger.success(`report written to ${this.out}`)
    } else {
      this.logger.log(output)
    }
  }

  async #runReport(): Promise<string> {
    const period: ReportPeriod = ['day', 'week', 'month'].includes(this.period)
      ? (this.period as ReportPeriod)
      : 'day'
    if (period !== this.period) {
      this.logger.warning(`unknown period "${this.period}", defaulting to "day"`)
    }

    const format: ReportFormat = isReportFormat(this.format) ? this.format : 'table'
    if (format !== this.format) {
      this.logger.warning(`unknown format "${this.format}", defaulting to "table"`)
    }

    const svc = await app.container.make(ReportingService)
    const [aggregate, topTenants, customMetrics] = await Promise.all([
      svc.getAggregate({ period, since: this.since, until: this.until }),
      svc.getTopTenants({ since: this.since, until: this.until, limit: this.top }),
      svc.getCustomMetricsBreakdown({ since: this.since, until: this.until }),
    ])

    return formatReport({ aggregate, topTenants, customMetrics }, format)
  }

  async #runExtension(): Promise<string> {
    const registry = await app.container.make(ReportExtensionRegistry)
    const ext = registry.get(this.extension!)
    if (!ext) {
      this.logger.error(
        `unknown report extension "${this.extension}". Registered: ${
          registry.list().join(', ') || '(none)'
        }`
      )
      this.exitCode = 1
      return ''
    }
    const result = await ext.execute({ since: this.since, until: this.until, period: this.period })
    return JSON.stringify(result, null, 2)
  }
}
