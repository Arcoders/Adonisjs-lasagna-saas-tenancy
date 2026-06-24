import redis from '@adonisjs/redis/services/main'
import db from '@adonisjs/lucid/services/db'
import TenantMetric from '../models/satellites/tenant_metric.js'
import TenantCustomMetric from '../models/satellites/tenant_custom_metric.js'
import TenantMetricMonthly from '../models/satellites/tenant_metric_monthly.js'
import { getConfig } from '../config.js'
import { assertEmitMetricArgs } from './metrics_validation.js'
import {
  buildMonthlyRollupSql,
  monthBuckets,
  monthChunkBounds,
  resolveRollupWindow,
} from '../rollup.js'
import { DateTime } from 'luxon'

/** Counter TTL: 48h, long enough to survive a delayed flush. */
const COUNTER_TTL_SECONDS = 172_800
/** Redis MGET fan-in width when flushing. */
const READ_CHUNK = 256
/** Rows per bulk-upsert statement when flushing. */
const WRITE_CHUNK = 500

export default class MetricsService {
  private key(tenantId: string, metric: string, period: string) {
    return `metrics:${tenantId}:${period}:${metric}`
  }

  private customKey(tenantId: string, name: string, period: string) {
    return `custom_metrics:${tenantId}:${period}:${name}`
  }

  private currentPeriod(): string {
    return DateTime.utc().toFormat('yyyy-MM-dd')
  }

  /**
   * Seam so specs can inject a Redis stub that rejects, to prove `emitMetric`
   * fails open. Production returns the lazily-bound `@adonisjs/redis` singleton.
   */
  protected getRedis(): typeof redis {
    return redis
  }

  async increment(tenantId: string, metric: 'requests' | 'errors', amount = 1): Promise<void> {
    const key = this.key(tenantId, metric, this.currentPeriod())
    // One round-trip instead of two: a crash between INCRBY and EXPIRE can't
    // leave a TTL-less counter, and the hot path pays a single Redis hop.
    await redis.pipeline().incrby(key, amount).expire(key, COUNTER_TTL_SECONDS).exec()
  }

  async trackBandwidth(tenantId: string, bytes: number): Promise<void> {
    const key = this.key(tenantId, 'bandwidth', this.currentPeriod())
    await redis.pipeline().incrby(key, bytes).expire(key, COUNTER_TTL_SECONDS).exec()
  }

  /**
   * Record a host-defined named metric (e.g. `emitMetric(t, 'rental_bookings', 1)`
   * or `emitMetric(t, 'revenue_cents', 1299)`). Rides the same Redis→backoffice
   * pipeline as the built-in counters: counters land under a `custom_metrics:`
   * key and are bulk-upserted to `backoffice.tenant_custom_metrics` by
   * {@link flushCustomMetrics} (which the `tenant:metrics:flush` command runs).
   *
   * Name and value are validated **fail-loud** (a bad name/value is a bug). The
   * Redis write is **fail-open** — a backend error never breaks the caller, and
   * `MetricRecorded` is dispatched only when the value was actually recorded.
   */
  async emitMetric(tenantId: string, name: string, value = 1): Promise<void> {
    assertEmitMetricArgs(name, value)
    const period = this.currentPeriod()
    const key = this.customKey(tenantId, name, period)
    try {
      await this.getRedis().pipeline().incrby(key, value).expire(key, COUNTER_TTL_SECONDS).exec()
    } catch (error) {
      // fail-open (matches config.resilience.redis.metrics default): nothing was
      // recorded, so there is nothing to announce.
      warnMetrics('emit_failed', error, { tenantId, name })
      return
    }
    await this.#dispatchRecorded(tenantId, name, value, period)
  }

  async #dispatchRecorded(
    tenantId: string,
    name: string,
    value: number,
    period: string
  ): Promise<void> {
    try {
      const { default: MetricRecorded } = await import('../events/metric_recorded.js')
      await MetricRecorded.dispatch({ tenantId, name, value, period })
    } catch {
      // best-effort: a throwing listener (or an unbooted emitter) must never
      // break the caller.
    }
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = []
    let cursor = '0'
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200)
      keys.push(...(batch as string[]))
      cursor = next as string
    } while (cursor !== '0')
    return keys
  }

  async flush(period?: string): Promise<void> {
    const target = period ?? this.currentPeriod()
    const pattern = `metrics:*:${target}:*`
    const keys = await this.scanKeys(pattern)
    if (keys.length === 0) return

    const tenantPeriods = new Map<string, { requests: number; errors: number; bandwidth: number }>()

    // Read every counter in chunked MGETs instead of one GET round-trip per key.
    // At T tenants × M metrics this collapses T×M sequential hops into
    // ceil(T×M / READ_CHUNK) — the difference between a multi-minute flush and a
    // sub-second one at scale.
    for (let i = 0; i < keys.length; i += READ_CHUNK) {
      const slice = keys.slice(i, i + READ_CHUNK)
      const values = await redis.mget(...slice)
      for (const [j, key] of slice.entries()) {
        const parts = key.split(':')
        const tenantId = parts[1]
        const metric = parts[3]
        const value = Number(values[j]) || 0

        let entry = tenantPeriods.get(tenantId)
        if (!entry) {
          entry = { requests: 0, errors: 0, bandwidth: 0 }
          tenantPeriods.set(tenantId, entry)
        }
        if (metric === 'requests') entry.requests = value
        else if (metric === 'errors') entry.errors = value
        else if (metric === 'bandwidth') entry.bandwidth = value
      }
    }

    const rows = [...tenantPeriods].map(([tenantId, counts]) => ({
      tenant_id: tenantId,
      period: target,
      request_count: counts.requests,
      error_count: counts.errors,
      bandwidth_bytes: counts.bandwidth,
    }))

    await this.#bulkUpsert(rows)
  }

  /**
   * Bulk `INSERT ... ON CONFLICT (tenant_id, period) DO UPDATE`, chunked, instead
   * of one `updateOrCreate` round-trip per tenant. Targets the backoffice schema
   * directly (TenantMetric is a BackofficeBaseModel) so the upsert is a single
   * statement per chunk.
   */
  async #bulkUpsert(
    rows: Array<{
      tenant_id: string
      period: string
      request_count: number
      error_count: number
      bandwidth_bytes: number
    }>
  ): Promise<void> {
    if (rows.length === 0) return
    const cfg = getConfig()
    const conn = db.connection(cfg.backofficeConnectionName)
    for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
      const batch = rows.slice(i, i + WRITE_CHUNK)
      await conn
        .insertQuery()
        .withSchema(cfg.backofficeSchemaName)
        .table(TenantMetric.table)
        .insert(batch)
        .onConflict(['tenant_id', 'period'])
        .merge(['request_count', 'error_count', 'bandwidth_bytes'])
    }
  }

  /**
   * Flush the host-defined `custom_metrics:*` counters for a period into
   * `backoffice.tenant_custom_metrics`, one row per (tenant, period, name). Same
   * SCAN → chunked MGET → chunked upsert shape as {@link flush}; a no-op when no
   * counters exist. Run alongside `flush()` by the `tenant:metrics:flush` command.
   */
  async flushCustomMetrics(period?: string): Promise<void> {
    const target = period ?? this.currentPeriod()
    const pattern = `custom_metrics:*:${target}:*`
    const keys = await this.scanKeys(pattern)
    if (keys.length === 0) return

    // key shape: custom_metrics:{tenantId}:{period}:{name}. Names are validated
    // by assertSafeIdentifier (no ':'), so parts[3] is the whole name.
    const byTenantName = new Map<string, { tenant_id: string; name: string; value: number }>()
    for (let i = 0; i < keys.length; i += READ_CHUNK) {
      const slice = keys.slice(i, i + READ_CHUNK)
      const values = await redis.mget(...slice)
      for (const [j, key] of slice.entries()) {
        const parts = key.split(':')
        const tenantId = parts[1]
        const name = parts[3]
        const value = Number(values[j]) || 0
        byTenantName.set(`${tenantId}|${name}`, { tenant_id: tenantId, name, value })
      }
    }

    const rows = [...byTenantName.values()].map((r) => ({
      tenant_id: r.tenant_id,
      period: target,
      name: r.name,
      value: r.value,
    }))

    await this.#bulkUpsertCustom(rows)
  }

  /**
   * Bulk `INSERT ... ON CONFLICT (tenant_id, period, name) DO UPDATE`, chunked,
   * for the tall custom-metrics table. Mirrors {@link #bulkUpsert}.
   */
  async #bulkUpsertCustom(
    rows: Array<{ tenant_id: string; period: string; name: string; value: number }>
  ): Promise<void> {
    if (rows.length === 0) return
    const cfg = getConfig()
    const conn = db.connection(cfg.backofficeConnectionName)
    for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
      const batch = rows.slice(i, i + WRITE_CHUNK)
      await conn
        .insertQuery()
        .withSchema(cfg.backofficeSchemaName)
        .table(TenantCustomMetric.table)
        .insert(batch)
        .onConflict(['tenant_id', 'period', 'name'])
        .merge(['value'])
    }
  }

  /**
   * Recompute the per-tenant monthly rollup (`tenant_metrics_monthly`) from the
   * daily `tenant_metrics` base, one upsert per month bucket so each statement's
   * working set stays bounded. Idempotent (`ON CONFLICT … DO UPDATE` overwrites,
   * never accumulates), so it is safe to re-run from cron. Omitted bounds default
   * to "first metric → last completed month" (the open month is excluded so a
   * partial month never lands in the rollup). A no-op on an empty base table.
   * Run by the `tenant:metrics:rollup` command.
   */
  async recomputeMonthlyRollup(options: { since?: string; until?: string } = {}): Promise<void> {
    const cfg = getConfig()
    const conn = db.connection(cfg.backofficeConnectionName)
    const schema = cfg.backofficeSchemaName

    const minResult = await conn.rawQuery(`SELECT MIN(period)::text AS min FROM ??.??`, [
      schema,
      TenantMetric.table,
    ])
    const minPeriod = (minResult.rows as Array<{ min: string | null }>)[0]?.min ?? null

    const window = resolveRollupWindow({
      minPeriod,
      since: options.since,
      until: options.until,
      asOf: DateTime.utc().toFormat('yyyy-MM-dd'),
    })
    if (!window) return

    const sql = buildMonthlyRollupSql()
    for (const monthStart of monthBuckets(window.since, window.until)) {
      const { lo, hi } = monthChunkBounds(monthStart, window)
      await conn.rawQuery(sql, [
        schema,
        TenantMetricMonthly.table,
        schema,
        TenantMetric.table,
        lo,
        hi,
      ])
    }
  }

  async getForTenant(tenantId: string, days = 30): Promise<TenantMetric[]> {
    const since = DateTime.utc().minus({ days }).toFormat('yyyy-MM-dd')
    return TenantMetric.query()
      .where('tenant_id', tenantId)
      .where('period', '>=', since)
      .orderBy('period', 'desc')
  }
}

/** Best-effort warning for a fail-open metrics path. Never throws. */
function warnMetrics(kind: string, err: unknown, ctx: Record<string, unknown>): void {
  try {
    console.warn(`[multitenancy] metrics ${kind}:`, (err as any)?.message ?? err, ctx)
  } catch {
    // ignore — logging must never throw out of a fail-open path
  }
}
