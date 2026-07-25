import { TenantBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import { DateTime } from 'luxon'
import Vehicle from '#app/models/tenant_scoped/vehicle'

export type MaintenanceType = 'service' | 'repair' | 'inspection' | 'cleaning'

/**
 * A maintenance event on a vehicle. `cost` is santimat; `odometer` is the
 * reading at the time of service.
 */
export default class MaintenanceRecord extends TenantBaseModel {
  static table = 'maintenance_records'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare vehicleId: string

  @column()
  declare type: MaintenanceType

  @column()
  declare cost: number

  @column()
  declare odometer: number

  @column.dateTime()
  declare performedAt: DateTime

  @column()
  declare notes: string | null

  @belongsTo(() => Vehicle, { foreignKey: 'vehicleId' })
  declare vehicle: BelongsTo<typeof Vehicle>

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
