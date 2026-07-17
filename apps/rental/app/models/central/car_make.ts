import { CentralBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { column, hasMany } from '@adonisjs/lucid/orm'
import type { HasMany } from '@adonisjs/lucid/types/relations'
import { DateTime } from 'luxon'
import CarModel from '#app/models/central/car_model'

/**
 * A car manufacturer in the shared, cross-company catalog. CentralBaseModel
 * routes every query to the central (`public`) connection, so this table is a
 * single global list every company's fleet selects from — the one place the
 * demo uses the central realm that the reference API leaves idle.
 */
export default class CarMake extends CentralBaseModel {
  static table = 'car_makes'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare name: string

  @column()
  declare slug: string

  @column()
  declare country: string | null

  @hasMany(() => CarModel, { foreignKey: 'makeId' })
  declare models: HasMany<typeof CarModel>

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
