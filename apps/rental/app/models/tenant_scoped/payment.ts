import { TenantBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export type PaymentMethod = 'cash' | 'card' | 'transfer'
export type PaymentStatus = 'pending' | 'paid' | 'refunded' | 'failed'

/**
 * A payment a renter makes against a booking (the DOMAIN money flow — distinct
 * from the billing satellite, which is the company paying Karimoto for the SaaS
 * subscription). `amount` is santimat.
 */
export default class Payment extends TenantBaseModel {
  static table = 'payments'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare bookingId: string

  @column()
  declare amount: number

  @column()
  declare currency: string

  @column()
  declare method: PaymentMethod

  @column()
  declare status: PaymentStatus

  @column()
  declare reference: string | null

  @column.dateTime()
  declare paidAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
