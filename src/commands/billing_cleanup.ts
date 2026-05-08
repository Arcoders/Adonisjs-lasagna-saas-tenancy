import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { runBillingCleanup } from '../jobs/billing_cleanup_job.js'

/**
 * Inline-runs the cleanup. Suggested cron: daily off-peak
 * (`0 4 * * * node ace tenant:billing:cleanup`). Defaults purge events
 * older than `config.billing.webhook.idempotencyTtlDays` (90 days).
 */
export default class BillingCleanup extends BaseCommand {
  static readonly commandName = 'tenant:billing:cleanup'
  static readonly description =
    'Purge stripe_processed_events older than the configured retention window'
  static readonly options: CommandOptions = { startApp: true }

  @flags.number({
    flagName: 'batch-size',
    default: 1000,
    description: 'Rows per delete batch — keeps individual transactions short',
  })
  declare batchSize: number

  async run() {
    const result = await runBillingCleanup({ batchSize: this.batchSize })
    this.logger.success(
      `purged ${result.deleted} stripe_processed_events older than ${result.cutoff}`
    )
  }
}
