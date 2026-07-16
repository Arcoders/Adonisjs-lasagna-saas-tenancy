import { TenantBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/**
 * A trivial tenant-scoped model. Lives in `tenant_<uuid>.notes` thanks to
 * TenantBaseModel routing. Use it to prove schema isolation: a POST to
 * /demo/notes writes to tenant_A.notes and a GET reads back from the same
 * schema, while switching the x-tenant-id header exposes a completely
 * separate row set.
 */
export default class Note extends TenantBaseModel {
  static table = 'notes'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare title: string

  @column()
  declare body: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
