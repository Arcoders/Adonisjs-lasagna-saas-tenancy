import { TenantBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/**
 * The signed contract for a booking. `signedAt` stays null until the renter
 * signs; `pdfRef`/`signatureRef` point at externally stored artefacts.
 */
export default class RentalAgreement extends TenantBaseModel {
  static table = 'rental_agreements'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare bookingId: string

  @column()
  declare terms: string | null

  @column.dateTime()
  declare signedAt: DateTime | null

  @column()
  declare signatureRef: string | null

  @column()
  declare pdfRef: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
