import { TenantBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import { DateTime } from 'luxon'
import VehicleCategory from '#app/models/tenant_scoped/vehicle_category'
import RentalLocation from '#app/models/tenant_scoped/rental_location'

export type VehicleStatus = 'available' | 'rented' | 'maintenance' | 'retired'
export type FuelType = 'petrol' | 'diesel' | 'hybrid' | 'electric'
export type Transmission = 'manual' | 'automatic'

/**
 * A vehicle in a company's fleet. `makeId`/`modelId` reference the shared
 * central catalog (`car_makes`/`car_models`); their names are denormalised onto
 * `makeName`/`modelName` so a fleet listing never has to cross the connection
 * boundary to render. `status` is the availability state machine FleetService
 * transitions.
 */
export default class Vehicle extends TenantBaseModel {
  static table = 'vehicles'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare plate: string

  @column()
  declare makeId: number

  @column()
  declare modelId: number

  @column()
  declare makeName: string

  @column()
  declare modelName: string

  @column()
  declare year: number

  @column()
  declare categoryId: string

  @column()
  declare locationId: string | null

  @column()
  declare status: VehicleStatus

  @column()
  declare mileage: number

  @column()
  declare fuel: FuelType

  @column()
  declare transmission: Transmission

  @column()
  declare color: string | null

  @belongsTo(() => VehicleCategory, { foreignKey: 'categoryId' })
  declare category: BelongsTo<typeof VehicleCategory>

  @belongsTo(() => RentalLocation, { foreignKey: 'locationId' })
  declare location: BelongsTo<typeof RentalLocation>

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
