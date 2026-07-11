import { BackofficeBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/**
 * Append-only read model of provider invoices (fiscal opt-in). For reporting and
 * reconciliation only: the provider stays the system of record. No local
 * invoice numbering, no tax calculation: every amount is what the provider
 * charged (integer minor units). Written by the dispatcher on
 * `payment.succeeded` when `config.billing.fiscal.enabled`, idempotent via the
 * `UNIQUE (provider, provider_invoice_id)` constraint. Ships with the opt-in
 * fiscal migration.
 */
export default class BillingInvoiceSnapshot extends BackofficeBaseModel {
  static readonly table = 'billing_invoice_snapshots'

  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare provider: string

  @column()
  declare providerInvoiceId: string

  @column()
  declare tenantId: string | null

  @column()
  declare currency: string

  @column()
  declare subtotalCents: number

  @column()
  declare taxCents: number

  @column()
  declare totalCents: number

  @column()
  declare status: string

  @column()
  declare pdfUrl: string | null

  @column.dateTime()
  declare issuedAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
