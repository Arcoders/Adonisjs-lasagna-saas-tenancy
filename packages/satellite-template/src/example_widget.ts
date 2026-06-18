import { BackofficeBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/**
 * The satellite's backoffice model. Every satellite table lives in the shared
 * `backoffice` schema (never a per-tenant schema), scoped by `tenant_id` — so
 * cross-tenant reporting stays a single query. Extending `BackofficeBaseModel`
 * routes the model through the `BackofficeAdapter`.
 */
export default class ExampleWidget extends BackofficeBaseModel {
  static readonly table = 'example_widgets'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare tenantId: string

  @column()
  declare name: string

  @column()
  declare enabled: boolean

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
