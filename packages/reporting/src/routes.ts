import router from '@adonisjs/core/services/router'
import ReportingDashboardController from './controllers/reporting_dashboard_controller.js'
import { isAbsentReportingMiddleware } from './is_absent_middleware.js'
import { getReportingOpenAPISpec } from './openapi.js'

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

/**
 * The middleware a host attaches to the reporting routes: a single entry or an
 * array of them, where each entry is a middleware name string, a bare function, or
 * a named-middleware reference, so the host supplies its own authentication for the
 * reporting dashboard endpoints.
 */
export type ReportingRouteMiddleware = ReportingMiddlewareEntry | ReportingMiddlewareEntry[]

export interface MultitenancyReportingRoutesOptions {
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
  /**
   * When > 0, dashboard responses are cached in the global `reporting` namespace
   * for this many milliseconds. Off by default (no behavior change). Caching is
   * cross-tenant/global by design — never tenant-scoped.
   */
  cacheTtlMs?: number
  /** Max allowed since→until span in days (default 366). Over-wide/inverted → 400. */
  maxRangeDays?: number
  /**
   * Mount `{prefix}/openapi.json` + `{prefix}/docs` (Swagger UI) under the same
   * auth as the dashboard. Off by default.
   */
  openapi?: boolean
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
/**
 * @deprecated Renamed to {@link MultitenancyReportingRoutesOptions} to match the
 * `Multitenancy*RoutesOptions` convention the other satellites use.
 */
export type ReportingRoutesOptions = MultitenancyReportingRoutesOptions

export function multitenancyReportingRoutes(
  options: MultitenancyReportingRoutesOptions = {}
): void {
  const { prefix = '/reporting', middleware, cacheTtlMs, maxRangeDays, openapi } = options

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
    const controller = new ReportingDashboardController({ cacheTtlMs, maxRangeDays })
    router.get('/dashboard', (ctx) => controller.dashboard(ctx))
    router.get('/reports/extension/:name', (ctx) => controller.extension(ctx))
    router.get('/reports/contract-version', (ctx) => controller.contractVersion(ctx))
    if (openapi) {
      router.get('/openapi.json', (ctx) => ctx.response.ok(getReportingOpenAPISpec(prefix)))
      router.get('/docs', (ctx) => {
        ctx.response.header('content-type', 'text/html')
        return ctx.response.send(swaggerHtml(`${prefix}/openapi.json`))
      })
    }
  }

  const group = router.group(define)
  if (prefix) group.prefix(prefix)
  if (guarded) (group as any).use(middleware)
}

/** Minimal Swagger UI page (CDN) pointed at the reporting OpenAPI document. */
function swaggerHtml(specUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Reporting API docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({ url: ${JSON.stringify(specUrl)}, dom_id: '#swagger-ui' })
  </script>
</body>
</html>`
}
