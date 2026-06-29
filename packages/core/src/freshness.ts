import { DateTime } from 'luxon'

/**
 * Pure helpers for the "how fresh is the reporting data?" signal. Reporting reads
 * the durable, flushed `tenant_metrics` table, so its newest data is the latest
 * flushed period — not "now". These coerce that value and decide staleness.
 * Dependency-free (luxon only) → fully unit-tested without a booted app. Shared by
 * `ReportingService.getDataAsOf` and the opt-in `metrics_freshness` doctor check.
 */

/**
 * Coerces a `MAX(period)` query row into a `yyyy-MM-dd` UTC date string, returning
 * null when the row is missing or its `as_of` field is null, undefined, or unparseable.
 * A JavaScript Date is read via luxon's `fromJSDate`, while any other value is stringified
 * and parsed as ISO. This helper never throws and underpins the reporting data-freshness signal.
 * @param row An optional object whose `as_of` field holds a Date, ISO string, or null.
 * @returns The flushed period formatted as `yyyy-MM-dd`, or null when absent or invalid.
 */
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

/**
 * Computes the age of reporting data as a count of whole days between the `asOf`
 * date and the `now` date, both parsed as UTC ISO strings. Returns `null` when
 * `asOf` is absent or either value fails to parse, and otherwise floors the day
 * difference and clamps it to a minimum of zero so future timestamps from clock
 * skew never produce a negative result.
 *
 * @param asOf - The latest flushed metrics period as an ISO date string, or `null` when no data exists.
 * @param now - The reference instant as an ISO date string, compared in UTC.
 * @returns The non-negative whole-day age, or `null` when `asOf` is missing or unparseable.
 */
export function staleDays(asOf: string | null, now: string): number | null {
  if (!asOf) return null
  const a = DateTime.fromISO(asOf, { zone: 'utc' })
  const n = DateTime.fromISO(now, { zone: 'utc' })
  if (!a.isValid || !n.isValid) return null
  return Math.max(0, Math.floor(n.diff(a, 'days').days))
}
