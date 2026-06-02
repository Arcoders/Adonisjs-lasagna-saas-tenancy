import { BackofficeBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export type StripeMeterEventStatus = 'pending' | 'sent' | 'failed'

export default class StripeMeterEvent extends BackofficeBaseModel {
  static readonly table = 'stripe_meter_events'

  // The id column is `uuid` in Postgres with a `gen_random_uuid()` default,
  // but Lucid would default to generating a `cuid()` for string PKs and
  // pass that to INSERT — Postgres rejects with "invalid input syntax for
  // type uuid". `selfAssignPrimaryKey = true` tells Lucid the caller owns
  // the value; `BillingService.reportUsage` sets `randomUUID()` before save.
  static selfAssignPrimaryKey = true

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
