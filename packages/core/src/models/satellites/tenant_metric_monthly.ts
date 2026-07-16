import { BackofficeBaseModel } from '../base/backoffice_base_model.js'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/**
 * A per-tenant monthly rollup of `tenant_metrics`, one row per (tenant, month)
 * with `month` the first-of-month (UTC). Populated by
 * `MetricsService.recomputeMonthlyRollup()` (the `tenant:metrics:rollup` command)
 * and read by the `reporting` satellite's opt-in dual-read to serve whole-month,
 * fully-closed windows from a ~30x-smaller table than the daily base. Lives in the
 * shared backoffice schema. Aggregating it is isolation-safe by construction.
 */
export default class TenantMetricMonthly extends BackofficeBaseModel {
  static readonly table = 'tenant_metrics_monthly'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare tenantId: string

  @column()
  declare month: string

  @column({ consume: (v: string | null) => (v !== null ? Number(v) : 0) })
  declare requestCount: number

  @column({ consume: (v: string | null) => (v !== null ? Number(v) : 0) })
  declare errorCount: number

  @column({ consume: (v: string | null) => (v !== null ? Number(v) : 0) })
  declare bandwidthBytes: number

  @column.dateTime({ autoCreate: true })
  declare computedAt: DateTime
}
