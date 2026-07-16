import type { ReportAggregate, TopTenantMetric } from './types.js'

/**
 * errors / requests, clamped to [0, 1]. Returns 0 when there were no requests
 * (no division by zero). Pure. The unit tests pin this math.
 */
export function errorRate(errors: number, requests: number): number {
  if (!(requests > 0)) return 0
  return Math.min(1, errors / requests)
}

/**
 * Coerce a possibly-null / bigint-as-string SQL aggregate to a finite number.
 * Postgres returns `SUM(...)::bigint` as a string and `NULL` for empty groups.
 */
export function toNumber(value: unknown): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

/** Map a raw period-aggregate row (snake_case SQL aliases) to a neutral shape. */
export function mapAggregateRow(row: {
  bucket: unknown
  total_requests?: unknown
  total_errors?: unknown
  total_bandwidth?: unknown
  active_tenants?: unknown
}): ReportAggregate {
  const totalRequests = toNumber(row.total_requests)
  const totalErrors = toNumber(row.total_errors)
  const bucket =
    row.bucket instanceof Date ? row.bucket.toISOString().slice(0, 10) : String(row.bucket)
  return {
    period: bucket,
    totalRequests,
    totalErrors,
    totalBandwidthBytes: toNumber(row.total_bandwidth),
    activeTenants: toNumber(row.active_tenants),
    errorRate: errorRate(totalErrors, totalRequests),
  }
}

/** Map a raw top-tenant row to a neutral shape. */
export function mapTopTenantRow(row: {
  tenant_id: string
  requests?: unknown
  errors?: unknown
  bandwidth_bytes?: unknown
}): TopTenantMetric {
  const requests = toNumber(row.requests)
  const errors = toNumber(row.errors)
  return {
    tenantId: row.tenant_id,
    requests,
    errors,
    bandwidthBytes: toNumber(row.bandwidth_bytes),
    errorRate: errorRate(errors, requests),
  }
}

/** Clamp a requested top-N limit to a sane [1, 1000] range. */
export function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit ?? Number.NaN)) return 50
  return Math.min(1000, Math.max(1, Math.floor(limit as number)))
}
