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
