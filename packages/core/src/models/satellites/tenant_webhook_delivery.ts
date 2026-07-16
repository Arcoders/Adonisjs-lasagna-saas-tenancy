import { BackofficeBaseModel } from '../base/backoffice_base_model.js'
import { column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import TenantWebhook from './tenant_webhook.js'
import { DateTime } from 'luxon'

export type DeliveryStatus = 'pending' | 'success' | 'failed' | 'retrying'

export default class TenantWebhookDelivery extends BackofficeBaseModel {
  static readonly table = 'tenant_webhook_deliveries'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare webhookId: string

  @column()
  declare event: string

  @column()
  declare payload: Record<string, unknown>

  @column()
  declare statusCode: number | null

  @column()
  declare responseBody: string | null

  @column()
  declare attempt: number

  @column()
  declare status: DeliveryStatus

  @column.dateTime()
  declare nextRetryAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @belongsTo(() => TenantWebhook, { foreignKey: 'webhookId' })
  declare webhook: BelongsTo<typeof TenantWebhook>
}
