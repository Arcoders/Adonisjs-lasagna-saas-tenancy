import { BackofficeBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/**
 * Provider-agnostic customer mirror. One row per tenant. `provider` records
 * which billing driver owns `providerCustomerId` (e.g. Stripe `cus_…`, a Paddle
 * `ctm_…`, or a Lemon Squeezy numeric id).
 */
export default class BillingCustomer extends BackofficeBaseModel {
  static readonly table = 'billing_customers'

  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare tenantId: string

  @column()
  declare provider: string

  @column()
  declare providerCustomerId: string

  @column()
  declare defaultPaymentMethod: string | null

  @column()
  declare currency: string | null

  /**
   * ISO 3166-1 alpha-2 country, for tax-jurisdiction reporting. The column ships
   * with the opt-in fiscal migration; `BillingService.ensureCustomer` writes it
   * only when `config.billing.fiscal.enabled`, so non-fiscal installs (where the
   * column does not exist) never set it and Lucid omits it from writes.
   */
  @column()
  declare countryCode: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime()
  declare deletedAt: DateTime | null
}
