import { CentralBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import { DateTime } from 'luxon'
import CarMake from '#app/models/central/car_make'

/**
 * A model within a manufacturer, in the shared central catalog. A company's
 * Vehicle references `makeId`/`modelId` here so two companies picking "Dacia
 * Logan" point at the same catalog row, while their vehicles stay isolated in
 * their own schemas.
 */
export default class CarModel extends CentralBaseModel {
  static table = 'car_models'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare makeId: number

  @column()
  declare name: string

  @column()
  declare bodyType: string | null

  @belongsTo(() => CarMake, { foreignKey: 'makeId' })
  declare make: BelongsTo<typeof CarMake>

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
