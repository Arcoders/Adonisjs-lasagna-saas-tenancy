import { emitIsthmusEvent } from '../isthmus/audit.js'
import type { RouteMiddleware } from './routes.js'

/**
 * Fail-closed guard for the `/metrics` endpoint.
 *
 * The Prometheus output carries per-tenant labels (circuit-breaker state, queue
 * depths) and tenant counts by status, so a public `/metrics` leaks tenant
 * enumeration and business KPIs. Like `multitenancyAdminRoutes`, the route
 * helper refuses to mount it without an explicit guard, or an explicit `false`
 * opt-out.
 *
 * Only an explicit `false` is the public opt-out. Every other "effectively
 * absent" value is rejected: `undefined`, `null`, an empty string, and an
 * EMPTY ARRAY. The empty array is the dangerous one: a caller building the list
 * dynamically (`authEnabled ? [auth] : []`) would otherwise mount `/metrics`
 * public silently while looking like it passed a guard. `false` must be written
 * out to go public, on purpose.
 *
 * Lives in its own module (deliberately free of any `@adonisjs/core/services/
 * router` import) so the rule can be unit-tested without dragging in the router
 * service (which `await app.booted(...)`s at module evaluation and throws
 * outside an Ignitor).
 */
export function isAbsentMiddleware(
  metricsMiddleware: RouteMiddleware | false | null | undefined
): boolean {
  if (metricsMiddleware === false) return false // explicit public opt-out, not absent
  if (metricsMiddleware === undefined || metricsMiddleware === null || metricsMiddleware === '') {
    return true
  }
  if (Array.isArray(metricsMiddleware) && metricsMiddleware.length === 0) return true
  return false
}

export function assertMetricsGuarded(
  metrics: boolean,
  metricsMiddleware: RouteMiddleware | false | null | undefined
): void {
  if (metrics && isAbsentMiddleware(metricsMiddleware)) {
    emitIsthmusEvent('guard.metrics_endpoint')
    throw new Error(
      'multitenancyRoutes: `metricsMiddleware` is required when `metrics` is enabled. The ' +
        '/metrics endpoint exposes per-tenant labels (circuit-breaker state, queue depths) and ' +
        'tenant counts by status, so it refuses to mount without a guard. Pass your auth (or a ' +
        'network guard), e.g. `multitenancyRoutes({ metricsMiddleware: middleware.auth() })`. To ' +
        'intentionally mount it public (only behind a trusted network boundary), pass ' +
        '`metricsMiddleware: false`. To not mount it at all, pass `metrics: false`.'
    )
  }
}
