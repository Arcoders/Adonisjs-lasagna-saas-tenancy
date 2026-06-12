import redis from '@adonisjs/redis/services/main'
import db from '@adonisjs/lucid/services/db'
import TenantMetric from '../models/satellites/tenant_metric.js'
import { getConfig } from '../config.js'
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

  private currentPeriod(): string {
    return DateTime.utc().toFormat('yyyy-MM-dd')
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

  async getForTenant(tenantId: string, days = 30): Promise<TenantMetric[]> {
    const since = DateTime.utc().minus({ days }).toFormat('yyyy-MM-dd')
    return TenantMetric.query()
      .where('tenant_id', tenantId)
      .where('period', '>=', since)
      .orderBy('period', 'desc')
  }
}
