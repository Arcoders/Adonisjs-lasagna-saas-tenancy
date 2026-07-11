import { DateTime } from 'luxon'
import type { ReportPeriod } from './types.js'

/** The only legal aggregation buckets. Drives both the 400-on-bad-input check
 *  (controller) and the safe fallback (service). */
export const REPORT_PERIODS: readonly ReportPeriod[] = ['day', 'week', 'month']

/** Type guard: is `value` one of the whitelisted periods? */
export function isReportPeriod(value: unknown): value is ReportPeriod {
  return typeof value === 'string' && (REPORT_PERIODS as readonly string[]).includes(value)
}

/** Resolve any input to a safe period, falling back to `'day'`. Used by the
 *  service so a stray cast can never interpolate `undefined` into SQL. */
export function resolvePeriod(value: unknown): ReportPeriod {
  return isReportPeriod(value) ? value : 'day'
}

/** True for an ISO `YYYY-MM-DD` that is also a real calendar date (rejects
 *  `2026-13-40`). Used by the controller to 400 bad `since`/`until` instead of
 *  letting Postgres raise a type-coercion error (500). */
export function isValidIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value).isValid
}

/**
 * Reject an inverted (`since > until`) or over-wide window. A safety cap so a
 * single dashboard request can't scan an unbounded range. `maxDays` defaults to
 * 366 so a full 12-month monthly view still works. Pure. The controller wraps
 * the throw into a 400. Both bounds must be valid ISO dates (the controller
 * validates that first); invalid input here is a no-op so this never masks the
 * dedicated ISO check.
 */
export function assertWindowWithinMax(since: string, until: string, maxDays = 366): void {
  const s = DateTime.fromISO(since)
  const u = DateTime.fromISO(until)
  if (!s.isValid || !u.isValid) return
  const days = u.diff(s, 'days').days
  if (days < 0) {
    throw new Error(`invalid window: "since" (${since}) is after "until" (${until})`)
  }
  if (days > maxDays) {
    throw new Error(
      `window too wide: ${Math.round(days)} days exceeds the ${maxDays}-day maximum — narrow since/until`
    )
  }
}
