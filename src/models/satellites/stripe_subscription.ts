import { BackofficeBaseModel } from '../base/backoffice_base_model.js'
import { column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import StripeCustomer from './stripe_customer.js'
import { DateTime } from 'luxon'

export type StripeSubscriptionStatus =
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused'

export default class StripeSubscription extends BackofficeBaseModel {
  static readonly table = 'stripe_subscriptions'

  static selfAssignPrimaryKey = true

  @column({ isPrimary: true, columnName: 'stripe_subscription_id' })
  declare stripeSubscriptionId: string

  // Nullable: the `tenant_destroy` listener drops the parent
  // `stripe_customers` row, and the FK is `ON DELETE SET NULL` so
  // the audit row survives with `tenantId = null`. Queries that
  // need to filter by tenant must guard against the null case.
  @column()
  declare tenantId: string | null

  @column()
  declare status: StripeSubscriptionStatus

  @column.dateTime()
  declare currentPeriodStart: DateTime

  @column.dateTime()
  declare currentPeriodEnd: DateTime

  @column()
  declare cancelAtPeriodEnd: boolean

  @column.dateTime()
  declare cancelAt: DateTime | null

  @column.dateTime()
  declare canceledAt: DateTime | null

  @column.dateTime()
  declare trialEnd: DateTime | null

  @column()
  declare planName: string

  @column.dateTime()
  declare lastEventAt: DateTime

  @column()
  declare raw: Record<string, unknown>

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @belongsTo(() => StripeCustomer, { foreignKey: 'tenantId', localKey: 'tenantId' })
  declare customer: BelongsTo<typeof StripeCustomer>
}
