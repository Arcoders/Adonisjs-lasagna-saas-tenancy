import { BackofficeBaseModel } from '../base/backoffice_base_model.js'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/**
 * A host-defined named metric, one row per (tenant, period, name). Populated by
 * `MetricsService.emitMetric()` → `flushCustomMetrics()` and aggregated
 * cross-tenant by the `reporting` satellite. Lives in the shared backoffice
 * schema (never a tenant's `search_path`), so aggregating it is isolation-safe by
 * construction — the same model the built-in `tenant_metrics` uses.
 */
export default class TenantCustomMetric extends BackofficeBaseModel {
  static readonly table = 'tenant_custom_metrics'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare tenantId: string

  @column()
  declare period: string

  @column()
  declare name: string

  @column({ consume: (v: string | null) => (v !== null ? Number(v) : 0) })
  declare value: number

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
