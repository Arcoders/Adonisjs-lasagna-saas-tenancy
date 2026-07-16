import db from '@adonisjs/lucid/services/db'
import TenantMetric from '../../models/satellites/tenant_metric.js'
import TenantCustomMetric from '../../models/satellites/tenant_custom_metric.js'
import { getConfig } from '../../config.js'

/**
 * The Redis surface the flush path needs. Structural on purpose: this module
 * never imports `@adonisjs/redis/services/main` (whose top-level `await
 * app.booted()` would drag the eager binding into module init). The live
 * handle is passed in from `MetricsService.getRedis()`, and a test can inject a
 * fake that only implements `scan` + `mget`.
 */
export interface FlushRedis {
  scan(cursor: string, ...args: Array<string | number>): Promise<[string, string[]]>
  mget(...keys: string[]): Promise<Array<string | null>>
}

/** Redis MGET fan-in width when flushing. */
const READ_CHUNK = 256
/** Rows per bulk-upsert statement when flushing. */
const WRITE_CHUNK = 500

async function scanKeys(redis: FlushRedis, pattern: string): Promise<string[]> {
  const keys: string[] = []
  let cursor = '0'
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200)
    keys.push(...batch)
    cursor = next
  } while (cursor !== '0')
  return keys
}

/**
 * Flush the built-in `metrics:*` counters for a period into
 * `backoffice.tenant_metrics`, one row per (tenant, period). SCAN, then chunked
 * MGET, then chunked upsert; a no-op when no counters exist.
 */
export async function flushBuiltInCounters(redis: FlushRedis, target: string): Promise<void> {
  const pattern = `metrics:*:${target}:*`
  const keys = await scanKeys(redis, pattern)
  if (keys.length === 0) return

  const tenantPeriods = new Map<string, { requests: number; errors: number; bandwidth: number }>()

  // Read every counter in chunked MGETs instead of one GET round-trip per key.
  for (let i = 0; i < keys.length; i += READ_CHUNK) {
    const slice = keys.slice(i, i + READ_CHUNK)
    const values = await redis.mget(...slice)
    for (const [j, key] of slice.entries()) {
      const parts = key.split(':')
      const tenantId = parts[1]!
      const metric = parts[3]!
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

  await bulkUpsert(rows)
}

/**
 * Bulk `INSERT ... ON CONFLICT (tenant_id, period) DO UPDATE`, chunked, instead
 * of one `updateOrCreate` round-trip per tenant.
 */
async function bulkUpsert(
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
 * SCAN, chunked MGET, chunked upsert shape as {@link flushBuiltInCounters}.
 */
export async function flushCustomCounters(redis: FlushRedis, target: string): Promise<void> {
  const pattern = `custom_metrics:*:${target}:*`
  const keys = await scanKeys(redis, pattern)
  if (keys.length === 0) return

  // key shape: custom_metrics:{tenantId}:{period}:{name}. Names are validated
  // by assertSafeIdentifier (no ':'), so parts[3] is the whole name.
  const byTenantName = new Map<string, { tenant_id: string; name: string; value: number }>()
  for (let i = 0; i < keys.length; i += READ_CHUNK) {
    const slice = keys.slice(i, i + READ_CHUNK)
    const values = await redis.mget(...slice)
    for (const [j, key] of slice.entries()) {
      const parts = key.split(':')
      const tenantId = parts[1]!
      const name = parts[3]!
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

  await bulkUpsertCustom(rows)
}

/**
 * Bulk `INSERT ... ON CONFLICT (tenant_id, period, name) DO UPDATE`, chunked,
 * for the tall custom-metrics table.
 */
async function bulkUpsertCustom(
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
