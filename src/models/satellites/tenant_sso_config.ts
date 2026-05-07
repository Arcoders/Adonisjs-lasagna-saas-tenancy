import { BackofficeBaseModel } from '../base/backoffice_base_model.js'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export default class TenantSsoConfig extends BackofficeBaseModel {
  static readonly table = 'tenant_sso_configs'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare tenantId: string

  @column()
  declare provider: string

  @column()
  declare clientId: string

  @column()
  declare clientSecret: string

  @column()
  declare issuerUrl: string

  @column()
  declare redirectUri: string

  @column()
  declare scopes: string[]

  @column()
  declare enabled: boolean

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
