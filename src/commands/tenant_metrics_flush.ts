import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { args } from '@adonisjs/core/ace'
import MetricsService from '../services/metrics_service.js'

export default class TenantMetricsFlush extends BaseCommand {
  static readonly commandName = 'tenant:metrics:flush'
  static readonly description = 'Flush Redis metric counters to the database for all tenants'
  static readonly options: CommandOptions = { startApp: true }

  @args.string({ description: 'Period to flush (YYYY-MM-DD). Defaults to today (UTC)', required: false })
  declare period: string | undefined

  async run() {
    const service = new MetricsService()
    await service.flush(this.period)
    this.logger.success(`Metrics flushed${this.period ? ` for period ${this.period}` : ''}`)
  }
}
