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

  /**
   * Provider-independent dunning attempt counter. Incremented once per distinct
   * `payment.failed` event (guarded by `dunningLastEventId` so a job retry of
   * the same event can't double-count). The dispatcher escalates on
   * `max(provider.attemptCount, dunningAttempts)` so dunning works even for
   * providers that under-report attempts (Lemon Squeezy reports none). Reset to
   * 0 when a payment succeeds and recovers the subscription.
   */
  @column()
  declare dunningAttempts: number

  /** Event id of the last counted `payment.failed` — the per-event idempotency guard. */
  @column()
  declare dunningLastEventId: string | null

  /**
   * When `dunning.gracePeriodDays > 0`, the moment the grace window elapses and
   * `tenant:billing:sweep` should apply `dunning.action`. Null when no downgrade
   * is pending (grace=0 applies immediately; recovery clears it).
   */
  @column.dateTime()
  declare dunningDowngradeAt: DateTime | null

  /**
   * Stamped once `TrialEnding` has been emitted for this subscription (by the
   * native Stripe `trial_will_end` webhook OR the `tenant:billing:sweep`
   * fallback), so each subscription is notified exactly once across providers.
   */
  @column.dateTime()
  declare trialEndingNotifiedAt: DateTime | null

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
