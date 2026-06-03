import { withTenantScope } from '@adonisjs-lasagna/saas-tenancy'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/**
 * The rowscope-pg model: one shared `notes` table in the central schema with a
 * `tenant_id` column. `withTenantScope` injects `where tenant_id = <current>`
 * on reads and auto-fills it on writes, driven by the active `tenancy.run()`
 * context. Pinned to the central template connection (the rowscope driver
 * routes every tenant there).
 */
export default class BenchNoteScoped extends withTenantScope(BaseModel) {
  static table = 'notes'
  static connection = 'tenant'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare title: string

  @column()
  declare body: string | null

  @column()
  declare tenant_id: string

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
