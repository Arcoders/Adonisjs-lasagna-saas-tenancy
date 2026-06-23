import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import ReportingService from '../reporting_service.js'
import type { ReportPeriod } from '../types.js'

/**
 * Print a cross-tenant usage report to the console — handy for ops spot-checks,
 * a scheduled summary, or verifying the metrics pipeline.
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

  async run(): Promise<void> {
    const period: ReportPeriod = ['day', 'week', 'month'].includes(this.period)
      ? (this.period as ReportPeriod)
      : 'day'
    if (period !== this.period) {
      this.logger.warning(`unknown period "${this.period}", defaulting to "day"`)
    }

    const svc = await app.container.make(ReportingService)
    const aggregate = await svc.getAggregate({ period, since: this.since, until: this.until })
    const top = await svc.getTopTenants({ since: this.since, until: this.until, limit: this.top })

    this.logger.log(`\n=== usage by ${period} ===`)
    for (const row of aggregate) {
      this.logger.log(
        `${row.period}  requests=${row.totalRequests}  errors=${row.totalErrors}  ` +
          `errorRate=${(row.errorRate * 100).toFixed(1)}%  tenants=${row.activeTenants}`
      )
    }

    this.logger.log(`\n=== top ${this.top} tenants ===`)
    for (const t of top) {
      this.logger.log(
        `${t.tenantId}  requests=${t.requests}  errors=${t.errors}  ` +
          `errorRate=${(t.errorRate * 100).toFixed(1)}%`
      )
    }
  }
}
