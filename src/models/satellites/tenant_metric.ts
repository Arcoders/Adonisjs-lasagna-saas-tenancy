import { BackofficeBaseModel } from '../base/backoffice_base_model.js'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export default class TenantMetric extends BackofficeBaseModel {
  static readonly table = 'tenant_metrics'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare tenantId: string

  @column()
  declare period: string

  @column({ consume: (v: string | null) => (v !== null ? Number(v) : 0) })
  declare requestCount: number

  @column({ consume: (v: string | null) => (v !== null ? Number(v) : 0) })
  declare errorCount: number

  @column({ consume: (v: string | null) => (v !== null ? Number(v) : 0) })
  declare bandwidthBytes: number

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
