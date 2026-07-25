import { BackofficeBaseModel } from '../base/backoffice_base_model.js'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/**
 * Who an audit row is attributed to. `admin` is a human operator acting through the
 * backoffice, `system` an automated backend action with no human behind it, and `ai`
 * an action the AI assistant took on behalf of a staff member (the staff principal
 * it acted for is the row's `actorId`). Kept a first-class actor rather than a
 * metadata flag so "the assistant did this" is queryable and exportable, not buried.
 */
export type AuditActorType = 'admin' | 'system' | 'ai'

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
