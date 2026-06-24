import { assertSafeIdentifier } from './isolation/identifier.js'

/**
 * Pure, dependency-free validation for `MetricsService.emitMetric()`. Kept out of
 * the service module (which eagerly imports `@adonisjs/lucid/services/db` and so
 * can't be imported without a booted app) so the rules are unit-testable in
 * isolation.
 *
 * Validation is **fail-loud**: a bad metric name or value is a programming error,
 * surfaced immediately, never silently dropped. (The Redis write itself is
 * fail-open — that's a runtime degradation, handled in the service.)
 */

/**
 * A custom metric name must be a safe SQL/Redis identifier: it is interpolated
 * (parameterized) into the aggregation query by the reporting satellite and used
 * as a Redis key segment, so it must never contain quotes, colons, or other
 * metacharacters. UUID-style and snake_case names satisfy this.
 */
export function assertMetricName(name: string): void {
  assertSafeIdentifier(name, 'metric name')
}

/**
 * A custom metric value must be a finite integer. The Redis counter pipeline uses
 * `INCRBY`, which only accepts integers; monetary metrics use integer minor units
 * (e.g. cents) to avoid float drift.
 */
export function assertMetricValue(value: number): void {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(
      `Refusing to record metric value ${JSON.stringify(value)}: expected a finite integer ` +
        `(use integer minor units — e.g. cents — for monetary metrics).`
    )
  }
}

/** Validate both arguments before any Redis call. Throws on the first problem. */
export function assertEmitMetricArgs(name: string, value: number): void {
  assertMetricName(name)
  assertMetricValue(value)
}
