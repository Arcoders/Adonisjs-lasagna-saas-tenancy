import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { args } from '@adonisjs/core/ace'
import MetricsService from '../services/metrics_service.js'

export default class TenantMetricsFlush extends BaseCommand {
  static readonly commandName = 'tenant:metrics:flush'
  static readonly description = 'Flush Redis metric counters to the database for all tenants'
  static readonly options: CommandOptions = { startApp: true }

  @args.string({
    description: 'Period to flush (YYYY-MM-DD). Defaults to today (UTC)',
    required: false,
  })
  declare period?: string

  async run() {
    const service = new MetricsService()
    await service.flush(this.period)
    await service.flushCustomMetrics(this.period)
    await this.#announceFlushed()
    this.logger.success(`Metrics flushed${this.period ? ` for period ${this.period}` : ''}`)
  }

  /**
   * Announce the flush so read-side caches (e.g. the reporting dashboard) can
   * refresh. Best-effort: dispatched only after both flushes succeed, and a
   * throwing listener or an unbooted emitter must never fail the command. Fired
   * from the command (not `MetricsService.flush`) so it doesn't double-fire or
   * fire on standalone library use of `flush()`.
   */
  async #announceFlushed(): Promise<void> {
    try {
      const period = this.period ?? (await import('luxon')).DateTime.utc().toFormat('yyyy-MM-dd')
      const { default: MetricsFlushed } = await import('../events/metrics_flushed.js')
      await MetricsFlushed.dispatch({ period })
    } catch {
      // best-effort
    }
  }
}
