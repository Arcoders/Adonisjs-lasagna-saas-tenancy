import { BackofficeBaseModel } from '../base/backoffice_base_model.js'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export type StripeProcessedEventStatus = 'pending' | 'completed' | 'failed'

export default class StripeProcessedEvent extends BackofficeBaseModel {
  static readonly table = 'stripe_processed_events'

  static selfAssignPrimaryKey = true

  @column({ isPrimary: true, columnName: 'event_id' })
  declare eventId: string

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
  declare status: StripeProcessedEventStatus

  @column()
  declare payload: Record<string, unknown> | null
}
