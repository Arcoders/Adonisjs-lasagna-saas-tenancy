import { BackofficeBaseModel } from '../base/backoffice_base_model.js'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export default class StripeCustomer extends BackofficeBaseModel {
  static readonly table = 'stripe_customers'

  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare tenantId: string

  @column()
  declare stripeCustomerId: string

  @column()
  declare defaultPaymentMethod: string | null

  @column()
  declare currency: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime()
  declare deletedAt: DateTime | null
}
