import type { AggregationOptions } from './types.js'

/**
 * Build a stable, collision-free cache key for a dashboard query. Pure and
 * order-independent: the same logical query always maps to the same key, and any
 * differing parameter maps to a different key.
 *
 * The key lives in the **global** `reporting` cache namespace (a backoffice
 * scope), never a tenant scope — reporting data is cross-tenant by design. The
 * key therefore never contains a `tenant:` prefix; the unit test pins that so a
 * future change can't accidentally tenant-scope a cross-tenant result.
 */
export function reportingCacheKey(options: AggregationOptions = {}): string {
  const period = options.period ?? 'day'
  const since = options.since ?? ''
  const until = options.until ?? ''
  // limit only affects getTopTenants; normalize undefined/invalid to '' so it
  // doesn't fragment the cache.
  const limit =
    typeof options.limit === 'number' && Number.isFinite(options.limit) ? String(options.limit) : ''
  return `dashboard|period=${period}|since=${since}|until=${until}|limit=${limit}`
}
