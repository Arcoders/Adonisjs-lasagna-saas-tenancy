import type { AdminRouteMiddleware } from './routes.js'

/**
 * True when the supplied middleware is "effectively absent" and the admin routes
 * must fail closed: `undefined`, `null`, an empty string, or an empty array. An
 * explicit `false` is the deliberate public opt-out and is NOT absent.
 *
 * The empty array is the dangerous case: `authEnabled ? [auth] : []` would
 * otherwise mount the destructive admin API public silently while looking
 * guarded. `false` must be written out to go public, on purpose.
 *
 * Lives in its own module — free of any `@adonisjs/core/services/router` import —
 * so the rule can be unit-tested without dragging in the router service (which
 * `await app.booted(...)`s at module evaluation and throws outside an Ignitor).
 */
export function isAbsentAdminMiddleware(
  middleware: AdminRouteMiddleware | false | null | undefined
): boolean {
  if (middleware === false) return false
  if (middleware === undefined || middleware === null || middleware === '') return true
  if (Array.isArray(middleware) && middleware.length === 0) return true
  return false
}
