import { TenantBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export type LocationType = 'airport' | 'city' | 'depot'

/**
 * A branch where a company hands over and takes back vehicles. Tenant-scoped:
 * rows live in `tenant_<uuid>.rental_locations`.
 */
export default class RentalLocation extends TenantBaseModel {
  static table = 'rental_locations'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare name: string

  @column()
  declare type: LocationType

  @column()
  declare address: string | null

  @column()
  declare city: string

  @column()
  declare timezone: string

  @column()
  declare phone: string | null

  @column()
  declare openHour: number

  @column()
  declare closeHour: number

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
