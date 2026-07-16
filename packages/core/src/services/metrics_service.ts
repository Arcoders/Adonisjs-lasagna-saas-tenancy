import redis from '@adonisjs/redis/services/main'
import db from '@adonisjs/lucid/services/db'
import TenantMetric from '../models/satellites/tenant_metric.js'
import TenantMetricMonthly from '../models/satellites/tenant_metric_monthly.js'
import { getConfig } from '../config.js'
import { isSafeIdentifier } from './isolation/identifier.js'
import { assertEmitMetricArgs } from './metrics_validation.js'
import { flushBuiltInCounters, flushCustomCounters, type FlushRedis } from './metrics/flusher.js'
import {
  buildMonthlyRollupSql,
  monthBuckets,
  monthChunkBounds,
  resolveRollupWindow,
} from '../rollup.js'
import { DateTime } from 'luxon'

/** Counter TTL: 48h, long enough to survive a delayed flush. */
const COUNTER_TTL_SECONDS = 172_800

/**
 * Per-tenant usage metrics service that buffers counters in Redis and flushes them into
 * the backoffice schema. It increments built-in `requests`, `errors`, and `bandwidth`
 * counters and records host-defined named metrics via `emitMetric`, keying each value by
 * tenant id, period, and metric name with a 48-hour TTL. Flush methods drain the
 * `metrics:*` and `custom_metrics:*` Redis keys into `tenant_metrics` and
 * `tenant_custom_metrics`, while `recomputeMonthlyRollup` rebuilds the idempotent monthly
 * rollup and `getForTenant` reads back recent daily rows. Tenant ids are validated as safe
 * identifiers before touching the keyspace, and Redis writes fail open so a backend error
 * never breaks the caller.
 */
export default class MetricsService {
  private key(tenantId: string, metric: string, period: string) {
    return `metrics:${tenantId}:${period}:${metric}`
  }

  private customKey(tenantId: string, name: string, period: string) {
    return `custom_metrics:${tenantId}:${period}:${name}`
  }

  /**
   * Last line of defense against metric-key structure injection. The Redis key
   * uses `:` as its delimiter and the flusher parses the tenant id out of a fixed
   * positional slot (`flusher.ts` reads `parts[1]`), so a tenant id carrying a `:`
   * could forge or overwrite *another* tenant's row in `backoffice.tenant_metrics`.
   * Every real tenant id is already `SAFE_IDENT` (drivers assert it before any SQL),
   * so a non-safe id here is a bug or an attack: drop it fail-open rather than let
   * it reach the keyspace. Callers should also validate at the attribution seam.
   */
  #isSafeTenantId(tenantId: string, where: string): boolean {
    if (isSafeIdentifier(tenantId)) return true
    warnMetrics('unsafe_tenant_id', new Error(`rejected non-identifier tenant id`), {
      tenantId,
      where,
    })
    return false
  }

  private currentPeriod(): string {
    return DateTime.utc().toFormat('yyyy-MM-dd')
  }

  /**
   * Seam so specs can inject a Redis stub. Production returns the lazily-bound
   * `@adonisjs/redis` singleton. EVERY Redis access in this service routes
   * through here (increment, emit, flush) so a stub injected in a test sees all
   * of them, not just `emitMetric`.
   */
  protected getRedis(): typeof redis {
    return redis
  }

  async increment(tenantId: string, metric: 'requests' | 'errors', amount = 1): Promise<void> {
    if (!this.#isSafeTenantId(tenantId, metric)) return
    const key = this.key(tenantId, metric, this.currentPeriod())
    // One round-trip instead of two: a crash between INCRBY and EXPIRE can't
    // leave a TTL-less counter, and the hot path pays a single Redis hop.
    await this.getRedis().pipeline().incrby(key, amount).expire(key, COUNTER_TTL_SECONDS).exec()
  }

  async trackBandwidth(tenantId: string, bytes: number): Promise<void> {
    if (!this.#isSafeTenantId(tenantId, 'bandwidth')) return
    const key = this.key(tenantId, 'bandwidth', this.currentPeriod())
    await this.getRedis().pipeline().incrby(key, bytes).expire(key, COUNTER_TTL_SECONDS).exec()
  }

  /**
   * Record a host-defined named metric (e.g. `emitMetric(t, 'rental_bookings', 1)`
   * or `emitMetric(t, 'revenue_cents', 1299)`). Rides the same Redis-to-backoffice
   * pipeline as the built-in counters: counters land under a `custom_metrics:`
   * key and are bulk-upserted to `backoffice.tenant_custom_metrics` by
   * {@link flushCustomMetrics} (which the `tenant:metrics:flush` command runs).
   *
   * Name and value are validated **fail-loud** (a bad name/value is a bug). The
   * Redis write is **fail-open**: a backend error never breaks the caller, and
   * `MetricRecorded` is dispatched only when the value was actually recorded.
   */
  async emitMetric(tenantId: string, name: string, value = 1): Promise<void> {
    assertEmitMetricArgs(name, value)
    if (!this.#isSafeTenantId(tenantId, `custom:${name}`)) return
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

  /**
   * Flush the built-in `metrics:*` counters for a period into
   * `backoffice.tenant_metrics`. Delegates the SCAN, MGET, and chunked upsert to
   * the flusher, passing the seam-resolved Redis handle.
   */
  async flush(period?: string): Promise<void> {
    const target = period ?? this.currentPeriod()
    // The seam handle is the full ioredis service; the flusher only needs the
    // minimal `scan`+`mget` surface (so a test fake stays small). ioredis's
    // overloaded signatures don't structurally narrow to that interface, so
    // bridge the impedance with one controlled cast at the boundary.
    await flushBuiltInCounters(this.getRedis() as unknown as FlushRedis, target)
  }

  /**
   * Flush the host-defined `custom_metrics:*` counters for a period into
   * `backoffice.tenant_custom_metrics`. Run alongside `flush()` by the
   * `tenant:metrics:flush` command.
   */
  async flushCustomMetrics(period?: string): Promise<void> {
    const target = period ?? this.currentPeriod()
    await flushCustomCounters(this.getRedis() as unknown as FlushRedis, target)
  }

  /**
   * Recompute the per-tenant monthly rollup (`tenant_metrics_monthly`) from the
   * daily `tenant_metrics` base, one upsert per month bucket so each statement's
   * working set stays bounded. Idempotent (`ON CONFLICT … DO UPDATE` overwrites,
   * never accumulates), so it is safe to re-run from cron. Omitted bounds default
   * to "first metric through last completed month" (the open month is excluded so a
   * partial month never lands in the rollup). A no-op on an empty base table.
   * Run by the `tenant:metrics:rollup` command.
   */
  async recomputeMonthlyRollup(
    options: { since?: string | undefined; until?: string | undefined } = {}
  ): Promise<void> {
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
      ...(options.since !== undefined ? { since: options.since } : {}),
      ...(options.until !== undefined ? { until: options.until } : {}),
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
    // ignore: logging must never throw out of a fail-open path
  }
}
