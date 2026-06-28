import { BackofficeBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export type BillingProcessedEventStatus = 'pending' | 'processing' | 'completed' | 'failed'

/**
 * Idempotency ledger for inbound webhooks. `event_id` (the provider's event id,
 * or a deterministic synthetic id for providers that omit one) is the dedupe
 * key; `payload` holds a PII-stripped, replayable copy of the neutral event.
 */
export default class BillingProcessedEvent extends BackofficeBaseModel {
  static readonly table = 'billing_processed_events'

  static selfAssignPrimaryKey = true

  @column({ isPrimary: true, columnName: 'event_id' })
  declare eventId: string

  @column()
  declare provider: string

  @column()
  declare eventType: string

  @column.dateTime({ autoCreate: true })
  declare processedAt: DateTime

  @column.dateTime()
  declare completedAt: DateTime | null

  @column()
  declare tenantId: string | null

  @column()
  declare attempts: number

  @column()
  declare lastError: string | null

  @column()
  declare status: BillingProcessedEventStatus

  @column()
  declare payload: Record<string, unknown> | null
}
