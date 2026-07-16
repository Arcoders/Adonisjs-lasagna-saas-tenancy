import { DateTime } from 'luxon'
import type { ReportPeriod } from './types.js'

/**
 * Pure source-selection for the optional monthly rollup. Decides whether a
 * cross-tenant aggregate can be served from the small `tenant_metrics_monthly`
 * table or must fall back to live aggregation over the daily base. Dependency-free
 * (luxon only) so every branch is unit-tested without a booted app. This carries
 * the satellite's high branch-coverage floor.
 *
 * The rollup is ONLY eligible for whole-month, fully-closed windows: a half month
 * can't be reconstructed from whole-month rows, and the current (still-being-
 * flushed) month must never be served stale. All inputs are `yyyy-MM-dd` strings,
 * which compare correctly lexicographically.
 */

/** First day of `iso`'s month (UTC), `yyyy-MM-dd`. */
export function monthOf(iso: string): string {
  return DateTime.fromISO(iso, { zone: 'utc' }).startOf('month').toFormat('yyyy-MM-dd')
}

/** Is `iso` the first day of its month? */
export function isFirstOfMonth(iso: string): boolean {
  return iso === monthOf(iso)
}

/** Is `iso` the last day of its month? */
export function isLastOfMonth(iso: string): boolean {
  return iso === DateTime.fromISO(iso, { zone: 'utc' }).endOf('month').toFormat('yyyy-MM-dd')
}

export interface RollupCoverageInput {
  /** Resolved window bounds (never undefined, since the service resolves defaults). */
  since: string
  until: string
  /** MIN(month)/MAX(month) present in the rollup table, or null when empty. */
  rollupMin: string | null
  rollupMax: string | null
  /** First-of-month of "today" (UTC): the OPEN, unrolled month. */
  asOfMonth: string
}

/**
 * True iff the rollup can serve `[since, until]`: the window is month-aligned, the
 * rollup is non-empty and spans it, and its last month is already CLOSED (strictly
 * before the open month). The closed-month rule is the correctness keystone: it
 * makes "a window ending in the open/unrolled month falls back to live" fall out
 * automatically, even if a stale rollup row happens to exist.
 */
export function coversClosedMonthWindow(input: RollupCoverageInput): boolean {
  const { since, until, rollupMin, rollupMax, asOfMonth } = input
  if (!isFirstOfMonth(since) || !isLastOfMonth(until)) return false
  if (!rollupMin || !rollupMax) return false
  const untilMonth = monthOf(until)
  if (untilMonth >= asOfMonth) return false // open / future month is never served from rollup
  return rollupMin <= since && rollupMax >= untilMonth
}

/**
 * Source for `getAggregate`: rollup only at `month` granularity over a covered,
 * closed, month-aligned window.
 */
export function chooseAggregateSource(
  input: RollupCoverageInput & { enabled: boolean; period: ReportPeriod }
): 'rollup' | 'live' {
  if (!input.enabled || input.period !== 'month') return 'live'
  return coversClosedMonthWindow(input) ? 'rollup' : 'live'
}

/**
 * Source for `getTopTenants`: it has no period of its own. A top-N over a window
 * is a plain per-tenant window-sum, which the monthly rollup serves whenever the
 * window is covered, closed, and month-aligned.
 */
export function chooseTopTenantsSource(
  input: RollupCoverageInput & { enabled: boolean }
): 'rollup' | 'live' {
  if (!input.enabled) return 'live'
  return coversClosedMonthWindow(input) ? 'rollup' : 'live'
}
