import type { ReportingRouteMiddleware } from './routes.js'

/**
 * True when the supplied middleware is "effectively absent" and the reporting
 * routes must fail closed: `undefined`, `null`, an empty string, or an empty
 * array. An explicit `false` is the deliberate public opt-out and is NOT absent.
 *
 * The empty array is the dangerous case: `authEnabled ? [auth] : []` would
 * otherwise mount the fleet-wide analytics endpoint public silently while
 * looking guarded. `false` must be written out to go public, on purpose.
 *
 * Lives in its own module — free of any `@adonisjs/core/services/router` import —
 * so the rule can be unit-tested without dragging in the router service (which
 * `await app.booted(...)`s at module evaluation and throws outside an Ignitor).
 * Mirrors the admin satellite's `isAbsentAdminMiddleware`; reporting clones it
 * rather than depend on admin (admin is RC, reporting is experimental).
 */
export function isAbsentReportingMiddleware(
  middleware: ReportingRouteMiddleware | false | null | undefined
): boolean {
  if (middleware === false) return false
  if (middleware === undefined || middleware === null || middleware === '') return true
  if (Array.isArray(middleware) && middleware.length === 0) return true
  return false
}
