import { BackofficeBaseModel } from '../base/backoffice_base_model.js'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export default class TenantBranding extends BackofficeBaseModel {
  static readonly table = 'tenant_brandings'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare tenantId: string

  @column()
  declare fromName: string | null

  @column()
  declare fromEmail: string | null

  @column()
  declare logoUrl: string | null

  @column()
  declare primaryColor: string | null

  @column()
  declare supportUrl: string | null

  @column()
  declare emailFooter: Record<string, unknown> | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
