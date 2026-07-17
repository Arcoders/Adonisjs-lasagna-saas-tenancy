import { TenantBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/**
 * A company policy / FAQ document — the source corpus for the fleet assistant's
 * RAG. Its `body` is embedded into the per-tenant `ai_embeddings` store (folded
 * into each tenant schema by the AI satellite); `source` is the dedup key used
 * when ingesting via `POST /ai/embed`.
 */
export default class FleetDoc extends TenantBaseModel {
  static table = 'fleet_docs'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare title: string

  @column()
  declare body: string

  @column()
  declare source: string

  @column()
  declare embeddedAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
