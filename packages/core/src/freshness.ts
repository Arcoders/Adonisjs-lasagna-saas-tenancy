import { DateTime } from 'luxon'

/**
 * Pure helpers for the "how fresh is the reporting data?" signal. Reporting reads
 * the durable, flushed `tenant_metrics` table, so its newest data is the latest
 * flushed period — not "now". These coerce that value and decide staleness.
 * Dependency-free (luxon only) → fully unit-tested without a booted app. Shared by
 * `ReportingService.getDataAsOf` and the opt-in `metrics_freshness` doctor check.
 */

/** Coerce a `MAX(period)` row (Date, ISO string, or null) to `yyyy-MM-dd` | null. Never throws. */
export function mapDataAsOf(row: { as_of?: unknown } | undefined): string | null {
  const raw = row?.as_of
  if (raw === null || raw === undefined) return null
  const dt =
    raw instanceof Date
      ? DateTime.fromJSDate(raw, { zone: 'utc' })
      : DateTime.fromISO(String(raw), { zone: 'utc' })
  return dt.isValid ? dt.toFormat('yyyy-MM-dd') : null
}

/**
 * Is the data stale? `null` asOf (no metrics at all) is stale. A `now − thresholdDays`
 * asOf is exactly at the boundary and counts as fresh (`>` not `>=`). A future asOf
 * (clock skew) is fresh. An unparseable asOf is conservatively treated as stale.
 */
export function isStale(asOf: string | null, now: string, thresholdDays: number): boolean {
  if (!asOf) return true
  const a = DateTime.fromISO(asOf, { zone: 'utc' })
  const n = DateTime.fromISO(now, { zone: 'utc' })
  if (!a.isValid || !n.isValid) return true
  const ageDays = n.diff(a, 'days').days
  if (ageDays < 0) return false
  return ageDays > thresholdDays
}

/** Whole days between `asOf` and `now` (>= 0), or null when asOf is absent/invalid. */
export function staleDays(asOf: string | null, now: string): number | null {
  if (!asOf) return null
  const a = DateTime.fromISO(asOf, { zone: 'utc' })
  const n = DateTime.fromISO(now, { zone: 'utc' })
  if (!a.isValid || !n.isValid) return null
  return Math.max(0, Math.floor(n.diff(a, 'days').days))
}
