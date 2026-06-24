import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { resolveTenantRepository, mapDataAsOf } from '@adonisjs-lasagna/saas-tenancy/services'
import {
  TenantMetric,
  TenantCustomMetric,
  TenantMetricMonthly,
} from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type {
  AggregationOptions,
  CustomMetricBreakdown,
  ReportAggregate,
  TenantUsage,
  TopTenantMetric,
} from './types.js'
import { clampLimit, mapAggregateRow, mapTopTenantRow } from './aggregate.js'
import {
  aggregationSql,
  assertSafeMetricName,
  mapCustomBreakdownRow,
  resolveCustomAggregation,
  type CustomAggregation,
} from './custom_aggregate.js'
import { resolvePeriod } from './validate.js'
import { chooseAggregateSource, chooseTopTenantsSource } from './rollup_source.js'
import type { MultitenancyConfigWithReporting } from './validate_config.js'
import { assertNotInTenantScope } from './guard.js'

/**
 * The SQL expression that buckets the `period` date column. Whitelisted (never
 * built from user input) so it is safe to interpolate into the raw query.
 */
const BUCKET_SQL: Record<NonNullable<AggregationOptions['period']>, string> = {
  day: 'period',
  week: "DATE_TRUNC('week', period)::date",
  month: "DATE_TRUNC('month', period)::date",
}

/**
 * Cross-tenant reporting over the backoffice `tenant_metrics` table. Aggregating
 * in the shared backoffice schema is isolation-safe by construction — these
 * queries never enter a tenant's `search_path`. Requires PostgreSQL 13+
 * (`DATE_TRUNC`).
 *
 * Every public method is guarded by {@link assertNotInTenantScope} so a reporting
 * query can never accidentally run inside a `tenancy.run()` scope.
 */
export default class ReportingService {
  /**
   * Totals + error rate per period bucket (day/week/month), newest first.
   */
  async getAggregate(options: AggregationOptions = {}): Promise<ReportAggregate[]> {
    assertNotInTenantScope('getAggregate', tenancy.currentId)
    // Defense-in-depth: BUCKET_SQL is whitelisted, but resolve through
    // resolvePeriod() so an out-of-enum `period` (e.g. a bad cast from a direct
    // caller) falls back to 'day' instead of interpolating `undefined` into the
    // SQL. HTTP callers are already rejected with 400 upstream.
    const period = resolvePeriod(options.period)
    const { since, until } = this.#window(options)

    // Opt-in fast path: a whole-month, fully-closed, covered window is served from
    // the small monthly rollup instead of SUM-ing the daily base. The result is
    // identical (proven by an equivalence test); the source pick is a pure function.
    if (this.rollupsEnabled() && period === 'month') {
      const { min, max } = await this.rollupBounds()
      const source = chooseAggregateSource({
        enabled: true,
        period,
        since,
        until,
        rollupMin: min,
        rollupMax: max,
        asOfMonth: this.#asOfMonth(),
      })
      if (source === 'rollup') return this.#aggregateFromRollup(since, until)
    }

    const bucket = BUCKET_SQL[period]
    const { conn, schema } = this.backoffice()

    const result = await conn.rawQuery(
      `SELECT ${bucket} AS bucket,
              SUM(request_count)::bigint   AS total_requests,
              SUM(error_count)::bigint     AS total_errors,
              SUM(bandwidth_bytes)::bigint AS total_bandwidth,
              COUNT(DISTINCT tenant_id)::bigint AS active_tenants
       FROM ??.??
       WHERE period >= ? AND period <= ?
       GROUP BY bucket
       ORDER BY bucket DESC`,
      [schema, TenantMetric.table, since, until]
    )
    return (result.rows as Parameters<typeof mapAggregateRow>[0][]).map(mapAggregateRow)
  }

  /**
   * Top-N tenants by request volume over the window, busiest first.
   */
  async getTopTenants(options: AggregationOptions = {}): Promise<TopTenantMetric[]> {
    assertNotInTenantScope('getTopTenants', tenancy.currentId)
    const { since, until } = this.#window(options)
    const limit = clampLimit(options.limit)

    // Top-N is a plain per-tenant window-sum, so the monthly rollup serves it for
    // any covered, closed, month-aligned window (no period concept of its own).
    if (this.rollupsEnabled()) {
      const { min, max } = await this.rollupBounds()
      const source = chooseTopTenantsSource({
        enabled: true,
        since,
        until,
        rollupMin: min,
        rollupMax: max,
        asOfMonth: this.#asOfMonth(),
      })
      if (source === 'rollup') return this.#topTenantsFromRollup(since, until, limit)
    }

    const { conn, schema } = this.backoffice()

    const result = await conn.rawQuery(
      `SELECT tenant_id,
              SUM(request_count)::bigint   AS requests,
              SUM(error_count)::bigint     AS errors,
              SUM(bandwidth_bytes)::bigint AS bandwidth_bytes
       FROM ??.??
       WHERE period >= ? AND period <= ?
       GROUP BY tenant_id
       ORDER BY SUM(request_count) DESC
       LIMIT ?`,
      [schema, TenantMetric.table, since, until, limit]
    )
    return (result.rows as Parameters<typeof mapTopTenantRow>[0][]).map(mapTopTenantRow)
  }

  /**
   * Iterate every tenant that has metrics in the window, busiest first, yielding
   * the hydrated tenant model alongside its aggregated usage. The grouped row set
   * (one row per tenant) is read once; tenant models are hydrated lazily per
   * yield, so memory stays bounded by the number of tenants, not metric rows.
   *
   * Resolves with `includeDeleted: true` (`findById(id, true)`) on purpose:
   * soft-deleted tenants still own valid historical metrics worth reporting on.
   */
  async *iterateTenantsByUsage(
    options: AggregationOptions = {}
  ): AsyncIterable<{ tenant: TenantModelContract; usage: TenantUsage }> {
    assertNotInTenantScope('iterateTenantsByUsage', tenancy.currentId)
    const { conn, schema } = this.backoffice()
    const { since, until } = this.#window(options)
    const repo = await resolveTenantRepository()

    const result = await conn.rawQuery(
      `SELECT tenant_id,
              SUM(request_count)::bigint   AS requests,
              SUM(error_count)::bigint     AS errors,
              SUM(bandwidth_bytes)::bigint AS bandwidth_bytes
       FROM ??.??
       WHERE period >= ? AND period <= ?
       GROUP BY tenant_id
       ORDER BY SUM(request_count) DESC`,
      [schema, TenantMetric.table, since, until]
    )

    for (const row of result.rows as Parameters<typeof mapTopTenantRow>[0][]) {
      const tenant = await repo.findById(row.tenant_id, true)
      if (!tenant) continue
      const mapped = mapTopTenantRow(row)
      yield {
        tenant,
        usage: {
          requests: mapped.requests,
          errors: mapped.errors,
          bandwidthBytes: mapped.bandwidthBytes,
        },
      }
    }
  }

  /**
   * Cross-tenant aggregate of one host-defined custom metric over the window.
   * The aggregation function is resolved through a whitelist (default `SUM`); the
   * metric name is validated and parameterized. Guarded like the built-ins.
   */
  async getCustomAggregate(
    options: AggregationOptions & { name: string; aggregation?: CustomAggregation }
  ): Promise<{ name: string; aggregation: CustomAggregation; value: number }> {
    assertNotInTenantScope('getCustomAggregate', tenancy.currentId)
    assertSafeMetricName(options.name)
    const aggregation = resolveCustomAggregation(options.aggregation)
    const fn = aggregationSql(aggregation)
    const { conn, schema } = this.backoffice()
    const { since, until } = this.#window(options)

    const result = await conn.rawQuery(
      `SELECT ${fn}(value)::bigint AS result
       FROM ??.??
       WHERE name = ? AND period >= ? AND period <= ?`,
      [schema, TenantCustomMetric.table, options.name, since, until]
    )
    const raw = (result.rows as Array<{ result: unknown }>)[0]?.result
    const value = Number(raw ?? 0)
    return { name: options.name, aggregation, value: Number.isFinite(value) ? value : 0 }
  }

  /**
   * Per-name cross-tenant totals (`SUM`) for every custom metric in the window,
   * newest names first by total. Unregistered names are included — config is
   * metadata, never a gate.
   */
  async getCustomMetricsBreakdown(
    options: AggregationOptions = {}
  ): Promise<CustomMetricBreakdown[]> {
    assertNotInTenantScope('getCustomMetricsBreakdown', tenancy.currentId)
    const { conn, schema } = this.backoffice()
    const { since, until } = this.#window(options)

    const result = await conn.rawQuery(
      `SELECT name, SUM(value)::bigint AS total
       FROM ??.??
       WHERE period >= ? AND period <= ?
       GROUP BY name
       ORDER BY SUM(value) DESC, name ASC`,
      [schema, TenantCustomMetric.table, since, until]
    )
    return (result.rows as Parameters<typeof mapCustomBreakdownRow>[0][]).map(mapCustomBreakdownRow)
  }

  /**
   * The freshest period present in `tenant_metrics` (`MAX(period)`) as `yyyy-MM-dd`,
   * or null when empty. Reports reflect FLUSHED data only, so this surfaces how
   * current that data is (see the data-freshness note in the docs) — there is no
   * Redis fallback by design. Cheap: served by `INDEX(period)`.
   */
  async getDataAsOf(): Promise<string | null> {
    assertNotInTenantScope('getDataAsOf', tenancy.currentId)
    const { conn, schema } = this.backoffice()
    const result = await conn.rawQuery(`SELECT MAX(period)::text AS as_of FROM ??.??`, [
      schema,
      TenantMetric.table,
    ])
    return mapDataAsOf((result.rows as Array<{ as_of: unknown }>)[0])
  }

  /**
   * Resolve the backoffice connection + schema. `protected` (not `#private`) so
   * resilience specs can subclass and inject a connection whose `rawQuery`
   * rejects, proving a Postgres outage fails cleanly.
   */
  protected backoffice() {
    const cfg = getConfig()
    return { conn: db.connection(cfg.backofficeConnectionName), schema: cfg.backofficeSchemaName }
  }

  /**
   * Whether the opt-in monthly rollup read path is enabled. `protected` so tests
   * can force it on without mutating global config. Reads the optional `reporting`
   * block off the core config (present at runtime when the host declares it).
   */
  protected rollupsEnabled(): boolean {
    const cfg = getConfig() as MultitenancyConfigWithReporting
    return cfg.reporting?.rollups?.enabled === true
  }

  /**
   * MIN/MAX month present in `tenant_metrics_monthly`, as `yyyy-MM-dd` strings (or
   * null when empty). Cheap (covered by `INDEX(month)`). `protected` for the chaos
   * outage subclass.
   */
  protected async rollupBounds(): Promise<{ min: string | null; max: string | null }> {
    const { conn, schema } = this.backoffice()
    const result = await conn.rawQuery(
      `SELECT MIN(month)::text AS min, MAX(month)::text AS max FROM ??.??`,
      [schema, TenantMetricMonthly.table]
    )
    const row = (result.rows as Array<{ min: string | null; max: string | null }>)[0] ?? {
      min: null,
      max: null,
    }
    return { min: row.min ?? null, max: row.max ?? null }
  }

  #asOfMonth(): string {
    return DateTime.utc().startOf('month').toFormat('yyyy-MM-dd')
  }

  async #aggregateFromRollup(since: string, until: string): Promise<ReportAggregate[]> {
    const { conn, schema } = this.backoffice()
    const result = await conn.rawQuery(
      `SELECT month AS bucket,
              SUM(request_count)::bigint   AS total_requests,
              SUM(error_count)::bigint     AS total_errors,
              SUM(bandwidth_bytes)::bigint AS total_bandwidth,
              COUNT(DISTINCT tenant_id)::bigint AS active_tenants
       FROM ??.??
       WHERE month >= ? AND month <= ?
       GROUP BY month
       ORDER BY month DESC`,
      [schema, TenantMetricMonthly.table, since, until]
    )
    return (result.rows as Parameters<typeof mapAggregateRow>[0][]).map(mapAggregateRow)
  }

  async #topTenantsFromRollup(
    since: string,
    until: string,
    limit: number
  ): Promise<TopTenantMetric[]> {
    const { conn, schema } = this.backoffice()
    const result = await conn.rawQuery(
      `SELECT tenant_id,
              SUM(request_count)::bigint   AS requests,
              SUM(error_count)::bigint     AS errors,
              SUM(bandwidth_bytes)::bigint AS bandwidth_bytes
       FROM ??.??
       WHERE month >= ? AND month <= ?
       GROUP BY tenant_id
       ORDER BY SUM(request_count) DESC
       LIMIT ?`,
      [schema, TenantMetricMonthly.table, since, until, limit]
    )
    return (result.rows as Parameters<typeof mapTopTenantRow>[0][]).map(mapTopTenantRow)
  }

  #window(options: AggregationOptions): { since: string; until: string } {
    return {
      since: options.since || DateTime.utc().minus({ days: 30 }).toFormat('yyyy-MM-dd'),
      until: options.until || DateTime.utc().toFormat('yyyy-MM-dd'),
    }
  }
}
