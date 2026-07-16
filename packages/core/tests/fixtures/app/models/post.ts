import { TenantBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { column } from '@adonisjs/lucid/orm'

/**
 * A minimal per-tenant model for integration tests that need to exercise the
 * TenantAdapter routing path (a raw `db.connection(...)` query bypasses the
 * adapter). The `posts` table is created per-tenant in the spec's setup.
 */
export default class Post extends TenantBaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare title: string
}
