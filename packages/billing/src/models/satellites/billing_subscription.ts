import { BackofficeBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import BillingCustomer from './billing_customer.js'
import { DateTime } from 'luxon'

export type BillingSubscriptionStatus =
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused'

/**
 * Provider-agnostic subscription mirror. The natural key is the provider's
 * subscription id; `provider` records which driver owns it (a single active
 * driver per deployment, so ids don't collide across providers).
 */
export default class BillingSubscription extends BackofficeBaseModel {
  static readonly table = 'billing_subscriptions'

  static selfAssignPrimaryKey = true

  @column({ isPrimary: true, columnName: 'provider_subscription_id' })
  declare providerSubscriptionId: string

  @column()
  declare provider: string

  // Nullable: the `tenant_destroy` listener drops the parent
  // `billing_customers` row, and the FK is `ON DELETE SET NULL` so the audit
  // row survives with `tenantId = null`. Queries that filter by tenant must
  // guard against the null case.
  @column()
  declare tenantId: string | null

  @column()
  declare status: BillingSubscriptionStatus

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

  @belongsTo(() => BillingCustomer, { foreignKey: 'tenantId', localKey: 'tenantId' })
  declare customer: BelongsTo<typeof BillingCustomer>
}
