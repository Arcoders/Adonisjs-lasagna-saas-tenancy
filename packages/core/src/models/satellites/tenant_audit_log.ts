import { BackofficeBaseModel } from '../base/backoffice_base_model.js'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export type AuditActorType = 'admin' | 'system'

export default class TenantAuditLog extends BackofficeBaseModel {
  static readonly table = 'tenant_audit_logs'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare tenantId: string | null

  @column()
  declare actorType: AuditActorType

  @column()
  declare actorId: string | null

  @column()
  declare action: string

  @column()
  declare metadata: Record<string, unknown> | null

  @column()
  declare ipAddress: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
