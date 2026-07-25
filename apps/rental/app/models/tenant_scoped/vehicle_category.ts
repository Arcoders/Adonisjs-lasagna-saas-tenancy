import { TenantBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export type CategoryCode = 'economy' | 'compact' | 'suv' | 'luxury' | 'van'

/**
 * A pricing tier for vehicles (economy, SUV, …). `dailyRate` and
 * `depositAmount` are stored in integer santimat (1 MAD = 100 santimat) to keep
 * money exact. `extras` is the list of add-ons this category offers.
 */
export default class VehicleCategory extends TenantBaseModel {
  static table = 'vehicle_categories'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare name: string

  @column()
  declare code: CategoryCode

  /** Daily rate in santimat (MAD × 100). */
  @column()
  declare dailyRate: number

  /** Refundable deposit in santimat. */
  @column()
  declare depositAmount: number

  @column({
    prepare: (value: string[] | null) => (value ? JSON.stringify(value) : '[]'),
    consume: (value: string | string[] | null) =>
      typeof value === 'string' ? (JSON.parse(value) as string[]) : (value ?? []),
  })
  declare extras: string[]

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
