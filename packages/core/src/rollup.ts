import { DateTime } from 'luxon'

/**
 * Pure helpers for the monthly metrics rollup. Dependency-free (luxon only) so
 * they unit-test without a booted app — the SQL string and the recompute window
 * are the branchy bits; `MetricsService.recomputeMonthlyRollup` is the thin glue
 * that binds + runs.
 */

/**
 * The idempotent recompute statement: collapse daily `tenant_metrics` rows into
 * one `(tenant, month)` row per tenant. `??.??` are identifier placeholders
 * (target schema.table, then source schema.table); `?` are the parameterized
 * date bounds. The conflict clause OVERWRITES with `EXCLUDED.*` (full recompute)
 * rather than `+= EXCLUDED` — so re-running over the same range is a no-op, never
 * a double-count. The month bucket is the whitelisted `DATE_TRUNC('month', …)`.
 */
export function buildMonthlyRollupSql(): string {
  return `INSERT INTO ??.?? (tenant_id, month, request_count, error_count, bandwidth_bytes, computed_at)
SELECT tenant_id,
       DATE_TRUNC('month', period)::date AS month,
       SUM(request_count)::bigint,
       SUM(error_count)::bigint,
       SUM(bandwidth_bytes)::bigint,
       now()
FROM ??.??
WHERE period >= ? AND period <= ?
GROUP BY tenant_id, DATE_TRUNC('month', period)::date
ON CONFLICT (tenant_id, month) DO UPDATE
  SET request_count   = EXCLUDED.request_count,
      error_count     = EXCLUDED.error_count,
      bandwidth_bytes = EXCLUDED.bandwidth_bytes,
      computed_at     = now()`
}

/** First day of `iso`'s month, `yyyy-MM-dd`. */
export function firstOfMonth(iso: string): string {
  return DateTime.fromISO(iso, { zone: 'utc' }).startOf('month').toFormat('yyyy-MM-dd')
}

/** Last day of `iso`'s month, `yyyy-MM-dd`. */
export function endOfMonth(iso: string): string {
  return DateTime.fromISO(iso, { zone: 'utc' }).endOf('month').toFormat('yyyy-MM-dd')
}

/**
 * The first-of-month markers for every month the `[since, until]` window touches,
 * ascending. Drives the month-by-month recompute so each upsert statement's
 * working set is bounded to a single month regardless of how wide the window is.
 * Returns `[]` for an inverted window.
 */
export function monthBuckets(since: string, until: string): string[] {
  let cursor = DateTime.fromISO(since, { zone: 'utc' }).startOf('month')
  const end = DateTime.fromISO(until, { zone: 'utc' }).startOf('month')
  const months: string[] = []
  while (cursor <= end) {
    months.push(cursor.toFormat('yyyy-MM-dd'))
    cursor = cursor.plus({ months: 1 })
  }
  return months
}

/**
 * The `[lo, hi]` daily bounds to recompute for one month bucket, clamped to the
 * overall window — so an explicit mid-month `since`/`until` only rolls up the days
 * inside the window, and whole interior months cover the full month.
 */
export function monthChunkBounds(
  monthStart: string,
  window: { since: string; until: string }
): { lo: string; hi: string } {
  const lo = monthStart > window.since ? monthStart : window.since
  const monthEnd = endOfMonth(monthStart)
  const hi = monthEnd < window.until ? monthEnd : window.until
  return { lo, hi }
}

/**
 * Last day of the month BEFORE `asOf`'s month, `yyyy-MM-dd` — the upper bound of
 * the default recompute window. Excluding the current (still-being-flushed) month
 * keeps a partial open month out of the rollup, which (with the read-side
 * open-month rule) means the dashboard serves the open month live until it closes
 * and a later run rolls it up. e.g. asOf 2026-06-24 → 2026-05-31.
 */
export function endOfLastCompletedMonth(asOf: string): string {
  return DateTime.fromISO(asOf, { zone: 'utc' })
    .startOf('month')
    .minus({ days: 1 })
    .toFormat('yyyy-MM-dd')
}

/**
 * Resolve the recompute window. Explicit `since`/`until` are honored verbatim
 * (a host may deliberately backfill — even the open month, which the read side
 * still refuses to serve). Omitted bounds default to: `since` = first-of-month of
 * the earliest metric, `until` = end of the last COMPLETED month. Returns `null`
 * when there's nothing to roll up (empty table and no explicit `since`), so the
 * command no-ops instead of running an unbounded statement.
 */
export function resolveRollupWindow(input: {
  minPeriod: string | null
  since?: string
  until?: string
  asOf: string
}): { since: string; until: string } | null {
  const since = input.since ?? (input.minPeriod ? firstOfMonth(input.minPeriod) : null)
  if (!since) return null
  const until = input.until ?? endOfLastCompletedMonth(input.asOf)
  return { since, until }
}
