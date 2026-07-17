import { TenantBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export interface InvoiceLine {
  description: string
  quantity: number
  unitAmount: number
  amount: number
}

/**
 * A VAT invoice for a booking. `number` is a per-company sequence
 * (`INV-YYYY-NNNN`). All money is santimat; `vat` is the 20% Moroccan TVA.
 */
export default class Invoice extends TenantBaseModel {
  static table = 'invoices'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare bookingId: string

  @column()
  declare number: string

  @column({
    prepare: (value: InvoiceLine[] | null) => (value ? JSON.stringify(value) : '[]'),
    consume: (value: string | InvoiceLine[] | null) =>
      typeof value === 'string' ? (JSON.parse(value) as InvoiceLine[]) : (value ?? []),
  })
  declare lines: InvoiceLine[]

  @column()
  declare subtotal: number

  @column()
  declare vat: number

  @column()
  declare total: number

  @column()
  declare currency: string

  @column.dateTime()
  declare issuedAt: DateTime

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
