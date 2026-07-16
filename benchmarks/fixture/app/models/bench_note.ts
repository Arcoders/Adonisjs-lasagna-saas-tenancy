import { TenantBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/**
 * The per-tenant model for schema-pg + database-pg. `TenantAdapter` routes its
 * queries to the active tenant's connection (resolved from the request header
 * or an active `tenancy.run()` context). The `notes` table is created per
 * tenant by the tenant migration.
 */
export default class BenchNote extends TenantBaseModel {
  static table = 'notes'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare title: string

  @column()
  declare body: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
