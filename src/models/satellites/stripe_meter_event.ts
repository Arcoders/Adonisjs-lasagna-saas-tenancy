import { BackofficeBaseModel } from '../base/backoffice_base_model.js'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export type StripeMeterEventStatus = 'pending' | 'sent' | 'failed'

export default class StripeMeterEvent extends BackofficeBaseModel {
  static readonly table = 'stripe_meter_events'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare tenantId: string

  @column()
  declare meterEventName: string

  @column()
  declare quantity: number

  @column()
  declare idempotencyKey: string

  @column.dateTime()
  declare reportedAt: DateTime | null

  @column()
  declare status: StripeMeterEventStatus

  @column()
  declare lastError: string | null

  @column()
  declare attempts: number

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
