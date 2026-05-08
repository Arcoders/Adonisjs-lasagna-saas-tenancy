import { BackofficeBaseModel } from '../base/backoffice_base_model.js'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export type TenantPlanSource = 'stripe' | 'manual' | 'backfill' | string

export default class TenantPlan extends BackofficeBaseModel {
  static readonly table = 'tenant_plans'

  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare tenantId: string

  @column()
  declare planName: string

  @column()
  declare source: TenantPlanSource

  @column.dateTime({ autoCreate: true })
  declare assignedAt: DateTime

  @column.dateTime()
  declare expiresAt: DateTime | null
}
