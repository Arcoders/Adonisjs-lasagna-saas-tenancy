import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import MetricsService from '../services/metrics_service.js'

/**
 * Recompute the per-tenant monthly rollup from `tenant_metrics`. Idempotent and
 * safe to re-run; pair it with `tenant:metrics:flush` on a schedule (flush daily,
 * roll up after the month closes). The `reporting` satellite reads the rollup for
 * whole-month windows when `config.reporting.rollups.enabled` is set.
 */
export default class TenantMetricsRollup extends BaseCommand {
  static readonly commandName = 'tenant:metrics:rollup'
  static readonly description =
    'Recompute the per-tenant monthly rollup of tenant_metrics (for fast whole-month reporting)'
  static readonly options: CommandOptions = { startApp: true }

  @flags.string({
    description: 'Start date (ISO YYYY-MM-DD). Default: the first recorded metric',
  })
  declare since?: string

  @flags.string({
    description: 'End date (ISO YYYY-MM-DD). Default: the end of the last completed month',
  })
  declare until?: string

  async run() {
    const service = new MetricsService()
    await service.recomputeMonthlyRollup({ since: this.since, until: this.until })
    this.logger.success(
      `Monthly rollup recomputed${this.since || this.until ? ` for ${this.since ?? '…'}…${this.until ?? '…'}` : ''}`
    )
  }
}
