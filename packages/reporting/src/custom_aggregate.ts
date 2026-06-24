import { toNumber } from './aggregate.js'
import type { CustomMetricBreakdown } from './types.js'

/**
 * The whitelisted SQL aggregation functions for custom metrics. The chosen
 * function name is interpolated into the raw query, so it MUST come from this
 * map — never from user input. `resolveCustomAggregation` folds any value down to
 * a safe member (default `sum`).
 *
 * Pure and dependency-free (only the pure `aggregate.js` helpers) so it stays
 * unit-testable without a booted app.
 */
export const CUSTOM_AGGREGATIONS = ['sum', 'avg', 'count', 'max', 'min'] as const

export type CustomAggregation = (typeof CUSTOM_AGGREGATIONS)[number]

const CUSTOM_AGG_SQL: Record<CustomAggregation, string> = {
  sum: 'SUM',
  avg: 'AVG',
  count: 'COUNT',
  max: 'MAX',
  min: 'MIN',
}

/** Type guard for the aggregation whitelist. */
export function isCustomAggregation(value: unknown): value is CustomAggregation {
  return typeof value === 'string' && (CUSTOM_AGGREGATIONS as readonly string[]).includes(value)
}

/** Resolve any input to a safe aggregation, defaulting to `sum`. */
export function resolveCustomAggregation(value: unknown): CustomAggregation {
  return isCustomAggregation(value) ? value : 'sum'
}

/**
 * The SQL function for an aggregation value, resolved through the whitelist. A
 * stray/malicious value can never inject SQL — it collapses to `SUM`.
 */
export function aggregationSql(value: unknown): string {
  return CUSTOM_AGG_SQL[resolveCustomAggregation(value)]
}

/**
 * A custom metric name must be a safe identifier (`/^[a-zA-Z0-9_-]{1,63}$/`). It
 * is parameterized into the query AND used as a Redis key segment, so it must
 * never carry quotes, colons, or whitespace. This mirrors core's
 * `assertSafeIdentifier` but is kept local so this module (and the config
 * validator) stay dependency-free.
 */
const SAFE_METRIC_NAME = /^[a-zA-Z0-9_-]{1,63}$/

export function isSafeMetricName(name: unknown): name is string {
  return typeof name === 'string' && SAFE_METRIC_NAME.test(name)
}

export function assertSafeMetricName(name: unknown): asserts name is string {
  if (!isSafeMetricName(name)) {
    throw new Error(
      `Refusing to use unsafe metric name ${JSON.stringify(name)} in a query. ` +
        `Metric names must match /^[a-zA-Z0-9_-]{1,63}$/.`
    )
  }
}

/** Map a raw `SELECT name, SUM(value) AS total` row to a neutral shape. */
export function mapCustomBreakdownRow(row: {
  name: string
  total?: unknown
}): CustomMetricBreakdown {
  return { name: row.name, total: toNumber(row.total) }
}
