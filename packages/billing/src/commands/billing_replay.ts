import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import BillingProcessedEvent from '../models/satellites/billing_processed_event.js'
import ProcessBillingEventJob from '../jobs/process_billing_event_job.js'

/**
 * Re-dispatch a webhook event the queue gave up on. Use after fixing the
 * underlying issue (e.g. missing config.billing.products entry).
 *
 *   node ace tenant:billing:replay --event-id=evt_xxx
 *   node ace tenant:billing:replay --all-failed
 */
export default class BillingReplay extends BaseCommand {
  static readonly commandName = 'tenant:billing:replay'
  static readonly description = 'Re-dispatch a failed webhook event for processing'
  static readonly options: CommandOptions = { startApp: true }

  @flags.string({ flagName: 'event-id', description: 'Specific provider event id' })
  declare eventId?: string

  @flags.boolean({
    flagName: 'all-failed',
    default: false,
    description: 'Replay every event currently in status=failed',
  })
  declare allFailed: boolean

  async run() {
    if (!this.eventId && !this.allFailed) {
      this.logger.error('Pass --event-id=<id> or --all-failed')
      this.exitCode = 1
      return
    }

    const targets = this.eventId
      ? [await BillingProcessedEvent.find(this.eventId)].filter((r) => r !== null)
      : await BillingProcessedEvent.query().where('status', 'failed')

    if (targets.length === 0) {
      this.logger.info('No matching events to replay.')
      return
    }

    let dispatched = 0
    for (const row of targets) {
      if (!row) continue
      // Reset state so the job will pick it up; attempts is intentionally
      // NOT reset — operators can use it to spot pathological events.
      row.status = 'pending'
      row.lastError = null
      await row.save()
      try {
        await ProcessBillingEventJob.dispatch({ eventId: row.eventId })
        dispatched += 1
        this.logger.success(`dispatched  ${row.eventId} (${row.eventType})`)
      } catch (err) {
        this.logger.error(`failed     ${row.eventId}: ${(err as Error)?.message ?? 'unknown'}`)
      }
    }
    this.logger.log(`replayed ${dispatched}/${targets.length}`)
  }
}
