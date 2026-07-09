import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { DateTime } from 'luxon'
import BillingProcessedEvent from '../models/satellites/billing_processed_event.js'

interface DeadLetter {
  event_id: string
  provider: string
  event_type: string
  tenant_id: string | null
  attempts: number
  last_error: string | null
  age_seconds: number
}

/**
 * Read-only inspection of dead-lettered webhook events (the `status='failed'`
 * rows on `billing_processed_events`). It is the missing read view to pair with
 * `tenant:billing:replay`, which re-dispatches them. Never mutates — reuses the
 * existing ledger rather than a separate DLQ table.
 *
 *   node ace tenant:billing:dlq:list
 *   node ace tenant:billing:dlq:list --json
 */
export default class BillingDlqList extends BaseCommand {
  static readonly commandName = 'tenant:billing:dlq:list'
  static readonly description = 'List dead-lettered (failed) webhook events — read-only'
  static readonly options: CommandOptions = { startApp: true }

  @flags.boolean({ flagName: 'json', default: false, description: 'Emit JSON' })
  declare json: boolean

  @flags.number({ flagName: 'limit', default: 100, description: 'Max rows to report' })
  declare limit: number

  async run() {
    // backoffice-scope-exempt: an operator command listing the dead-letter queue across ALL tenants (a fleet-wide maintenance view, not a tenant-scoped read).
    const rows = await BillingProcessedEvent.query()
      .where('status', 'failed')
      .orderBy('processedAt', 'asc')
      .limit(this.limit)

    const now = DateTime.utc()
    const events: DeadLetter[] = rows.map((r) => ({
      event_id: r.eventId,
      provider: r.provider,
      event_type: r.eventType,
      tenant_id: r.tenantId,
      attempts: r.attempts,
      last_error: r.lastError,
      age_seconds: Math.max(0, Math.floor(now.diff(r.processedAt, 'seconds').seconds)),
    }))

    if (this.json) {
      this.logger.log(JSON.stringify({ count: events.length, events }, null, 2))
      return
    }

    if (events.length === 0) {
      this.logger.success('No dead-lettered events (status=failed).')
      return
    }

    this.logger.log(`${this.colors.bold(String(events.length))} dead-lettered event(s):`)
    for (const e of events) {
      const ageMinutes = Math.floor(e.age_seconds / 60)
      this.logger.log(
        `${this.colors.red(e.event_id)}  ${e.provider}/${e.event_type}  ` +
          `attempts=${e.attempts}  age=${ageMinutes}m  ${e.last_error ?? ''}`
      )
    }
    this.logger.log('')
    this.logger.log('Replay after fixing the cause:  tenant:billing:replay --all-failed')
  }
}
