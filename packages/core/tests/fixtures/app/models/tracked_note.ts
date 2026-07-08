import { TenantBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { TracksDataChanges } from '@adonisjs-lasagna/saas-tenancy/mixins'
import { column } from '@adonisjs/lucid/orm'

/**
 * A per-tenant model wrapped in `TracksDataChanges` (SEAM-5) so the integration
 * suite can prove the mixin emits `TenantDataChanged` after a committed write and
 * NOTHING after a rollback, against real Postgres. The `tracked_notes` table is
 * created per-tenant in the spec's setup.
 */
export default class TrackedNote extends TracksDataChanges(TenantBaseModel) {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare body: string
}
