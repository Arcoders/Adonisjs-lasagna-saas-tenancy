import { BackofficeBaseModel } from '../base/backoffice_base_model.js'
import { column, hasMany } from '@adonisjs/lucid/orm'
import type { HasMany } from '@adonisjs/lucid/types/relations'
import TenantWebhookDelivery from './tenant_webhook_delivery.js'
import { DateTime } from 'luxon'

export default class TenantWebhook extends BackofficeBaseModel {
  static readonly table = 'tenant_webhooks'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare tenantId: string

  @column()
  declare url: string

  @column()
  declare events: string[]

  @column()
  declare secret: string | null

  @column()
  declare enabled: boolean

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @hasMany(() => TenantWebhookDelivery, { foreignKey: 'webhookId' })
  declare deliveries: HasMany<typeof TenantWebhookDelivery>
}
