import router from '@adonisjs/core/services/router'
import ReportingDashboardController from './controllers/reporting_dashboard_controller.js'
import { isAbsentReportingMiddleware } from './is_absent_middleware.js'

/**
 * One middleware entry, in any of the shapes Adonis' `group.use(...)` accepts at
 * runtime: a registered middleware name, a middleware function, or a
 * named-middleware reference produced by `router.named(...)` (the
 * `middleware.adminAuth()` shape, which carries a `handle` method).
 */
type ReportingMiddlewareEntry =
  | string
  | ((...args: any[]) => any)
  | { name?: string; handle: (...args: any[]) => any }

export type ReportingRouteMiddleware = ReportingMiddlewareEntry | ReportingMiddlewareEntry[]

export interface ReportingRoutesOptions {
  /** Mount prefix for the reporting routes. Default `/reporting`. */
  prefix?: string
  /**
   * Middleware applied to every reporting route. Pass a name (registered in the
   * app kernel), a callable, or an array of either.
   *
   * REQUIRED. The dashboard exposes fleet-wide, cross-tenant analytics, so it
   * refuses to mount without auth: omitting this throws at startup. To
   * intentionally mount the routes public — only ever behind a trusted network
   * boundary (a private VPC, an authenticating gateway, or local tests) — pass
   * `false` explicitly.
   */
  middleware?: ReportingRouteMiddleware | false
}

/**
 * Mount the cross-tenant reporting endpoints. Call from `start/routes.ts`. The
 * dashboard exposes fleet-wide usage (every tenant's request/error/bandwidth
 * totals), so this is **fail-closed**: it requires an explicit `middleware`, or
 * an explicit `middleware: false` to mount public on purpose.
 *
 * @example
 *   // start/routes.ts
 *   import { multitenancyReportingRoutes } from '@adonisjs-lasagna/reporting'
 *   import { middleware } from '#start/kernel'
 *
 *   multitenancyReportingRoutes({ middleware: middleware.adminAuth() })
 *
 * Endpoints (relative to the prefix, default `/reporting`):
 *   GET /dashboard   ?period=&since=&until=&limit=
 */
export function multitenancyReportingRoutes(options: ReportingRoutesOptions = {}): void {
  const { prefix = '/reporting', middleware } = options

  // Fail closed: the dashboard exposes cross-tenant analytics, so it must not
  // mount silently public. Require explicit auth, or an explicit `false` opt-out.
  // Only `false` is the public opt-out; every other "effectively absent" value
  // (undefined, null, '', and the dangerous EMPTY ARRAY) is rejected.
  if (isAbsentReportingMiddleware(middleware)) {
    throw new Error(
      'multitenancyReportingRoutes: `middleware` is required. The reporting dashboard exposes ' +
        'fleet-wide, cross-tenant analytics, so it refuses to mount without auth. Pass your auth ' +
        'middleware, e.g. `multitenancyReportingRoutes({ middleware: middleware.adminAuth() })`. ' +
        'To intentionally mount it public (only behind a trusted network boundary), pass `middleware: false`.'
    )
  }

  // `false` is the explicit "mount public" opt-out; anything else is real middleware.
  const guarded = middleware !== false

  const define = () => {
    const controller = new ReportingDashboardController()
    router.get('/dashboard', (ctx) => controller.dashboard(ctx))
  }

  const group = router.group(define)
  if (prefix) group.prefix(prefix)
  if (guarded) (group as any).use(middleware)
}
