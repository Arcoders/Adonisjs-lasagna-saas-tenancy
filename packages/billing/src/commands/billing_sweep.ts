import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { runBillingSweep } from '../jobs/billing_sweep_job.js'

/**
 * Inline-runs the periodic billing sweep: emits trial-ending notices (the
 * Paddle / Lemon Squeezy fallback for Stripe's native `trial_will_end`) and
 * applies grace-period dunning downgrades that are now due. Idempotent.
 * Suggested cron: hourly (`0 * * * * node ace tenant:billing:sweep`).
 */
export default class BillingSweep extends BaseCommand {
  static readonly commandName = 'tenant:billing:sweep'
  static readonly description =
    'Emit due trial-ending notices and apply due grace-period dunning downgrades'
  static readonly options: CommandOptions = { startApp: true }

  @flags.number({
    flagName: 'batch-size',
    default: 500,
    description: 'Rows per batch — keeps individual transactions short',
  })
  declare batchSize: number

  async run() {
    const result = await runBillingSweep({ batchSize: this.batchSize })
    this.logger.success(
      `sweep done: ${result.trialNotices} trial-ending notice(s), ${result.downgrades} grace downgrade(s)`
    )
  }
}
