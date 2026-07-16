import router from '@adonisjs/core/services/router'
import AdminController, { __setAdminActorResolver } from './admin_controller.js'
import type { AdminActorResolver } from './admin_actor.js'
import AuditLogsController from './controllers/audit_logs_controller.js'
import WebhooksController from './controllers/webhooks_controller.js'
import FeatureFlagsController from './controllers/feature_flags_controller.js'
import BrandingController from './controllers/branding_controller.js'
import SsoController from './controllers/sso_controller.js'
import MetricsController from './controllers/metrics_controller.js'
import QuotasController from './controllers/quotas_controller.js'
import AdminActionsController from './controllers/admin_actions_controller.js'
import { isAbsentAdminMiddleware } from './is_absent_middleware.js'

/**
 * One middleware entry, in any of the shapes Adonis' `group.use(...)`
 * accepts at runtime: a registered middleware name, a middleware function,
 * or a named-middleware reference produced by `router.named(...)` (the
 * `middleware.adminAuth()` shape, which carries a `handle` method).
 */
type AdminMiddlewareEntry =
  | string
  | ((...args: any[]) => any)
  | { name?: string; handle: (...args: any[]) => any }

/**
 * The middleware a host attaches to the admin routes: a single entry or an array
 * of them, where each entry is a middleware name string, a bare function, or a
 * named-middleware reference. It lets the host supply its own authentication for
 * the admin surface.
 */
export type AdminRouteMiddleware = AdminMiddlewareEntry | AdminMiddlewareEntry[]

/**
 * Hook that resolves the acting admin's id from the authenticated request.
 * Required when wiring impersonation endpoints. The package refuses to
 * trust an `adminId` field from the request body, since that would let any
 * caller falsify the audit trail. Return `null` to deny.
 *
 * Defined in `./admin_actor.js` and re-exported here so it stays the public
 * type the `index.js` barrel exposes.
 *
 * @example
 *   resolveAdminActor: ({ auth }) => auth.user?.id ?? null
 */
export type { AdminActorResolver }

export interface MultitenancyAdminRoutesOptions {
  /**
   * URL prefix for the admin endpoints. Default: `/admin/multitenancy`.
   * Pass an empty string to mount at root.
   */
  prefix?: string
  /**
   * Middleware applied to every admin route. Pass a name (registered in the
   * app kernel), a callable, or an array of either.
   *
   * REQUIRED. The admin API exposes destructive routes (tenant destroy,
   * impersonation, SSO config), so it refuses to mount without auth: omitting
   * this throws at startup. To intentionally mount the routes public, only
   * ever behind a trusted network boundary (a private VPC, an authenticating
   * gateway, or local tests), pass `false` explicitly.
   */
  middleware?: AdminRouteMiddleware | false
  /**
   * REQUIRED if you mount the impersonation endpoints. Must extract the
   * acting admin id from the authenticated context, typically
   * `({ auth }) => auth.user?.id`. NEVER read it from the request body.
   * Without this hook, the impersonation endpoint returns 501.
   */
  resolveAdminActor?: AdminActorResolver
  /**
   * When `true` (default), the OpenAPI spec endpoint (`/openapi.json`)
   * and Swagger UI (`/docs`) inherit `middleware`. The spec is a complete
   * map of the admin surface (impersonation paths, destructive routes,
   * SSO config). Leaving it public lets attackers enumerate the API
   * without triggering auth failures, so we gate it by default.
   *
   * Pass `false` if you publish the spec intentionally (developer
   * portal, internal Stoplight instance, etc.).
   */
  docsAuth?: boolean
  /**
   * Optional execution guards for host-registered admin actions (the
   * `POST {prefix}/actions/:name` route). Both off by default. Actions run
   * unguarded. `timeoutMs` is a response deadline (fires the action's
   * `AbortSignal`); `rateLimit` is a Redis-backed sliding window per
   * `(action, ip)`.
   */
  actions?: {
    timeoutMs?: number
    rateLimit?: { limit: number; windowSeconds: number }
  }
}

const DEFAULT_PREFIX = '/admin/multitenancy'

/**
 * Mount the admin REST API. Call from `start/routes.ts`:
 *
 * ```ts
 * import { multitenancyAdminRoutes } from '@adonisjs-lasagna/admin'
 * import { middleware } from '#start/kernel'
 *
 * multitenancyAdminRoutes({ middleware: middleware.adminAuth() })
 * ```
 *
 * Endpoints (relative to the prefix, default `/admin/multitenancy`):
 *
 * Tenants:
 *   GET    /tenants                       List tenants (?status=&includeDeleted=)
 *   POST   /tenants                       Create tenant + dispatch InstallTenant
 *   GET    /tenants/:id                   Show tenant
 *   POST   /tenants/:id/activate          Activate
 *   POST   /tenants/:id/suspend           Suspend
 *   POST   /tenants/:id/destroy           Destroy (?keepSchema=true|false)
 *   POST   /tenants/:id/restore           Restore (clear deletedAt)
 *   POST   /tenants/:id/maintenance       Enter maintenance
 *   DELETE /tenants/:id/maintenance       Exit maintenance
 *
 * Observability:
 *   GET    /tenants/:id/queue/stats       BullMQ stats
 *   GET    /health/report                 DoctorService.run() report
 *   GET    /openapi.json                  OpenAPI 3.1 spec
 *   GET    /docs                          Swagger UI
 *
 * Impersonation:
 *   POST   /tenants/:id/impersonations
 *   DELETE /impersonations/:token
 *   DELETE /impersonations/by-id/:sessionId
 *
 * Satellites:
 *   GET    /tenants/:id/audit-logs        ?page=&limit=
 *   GET    /tenants/:id/webhooks
 *   POST   /tenants/:id/webhooks
 *   PUT    /tenants/:id/webhooks/:webhookId
 *   DELETE /tenants/:id/webhooks/:webhookId
 *   GET    /tenants/:id/webhooks/:webhookId/deliveries
 *   POST   /tenants/:id/webhooks/deliveries/:deliveryId/retry
 *   GET    /tenants/:id/feature-flags
 *   POST   /tenants/:id/feature-flags
 *   PUT    /tenants/:id/feature-flags/:flagKey
 *   DELETE /tenants/:id/feature-flags/:flagKey
 *   GET    /tenants/:id/branding
 *   PUT    /tenants/:id/branding
 *   GET    /tenants/:id/sso
 *   PUT    /tenants/:id/sso
 *   POST   /tenants/:id/sso/disable
 *   GET    /tenants/:id/metrics           ?days=
 *   GET    /tenants/:id/quotas
 *   PUT    /tenants/:id/quotas/usage
 *   POST   /tenants/:id/quotas/reset
 */
export function multitenancyAdminRoutes(options: MultitenancyAdminRoutesOptions = {}): void {
  const {
    prefix = DEFAULT_PREFIX,
    middleware,
    resolveAdminActor,
    docsAuth = true,
    actions: actionGuards,
  } = options

  // Fail closed: the admin surface includes destructive routes, so it must not
  // mount silently public. Require explicit auth, or an explicit `false` opt-out.
  // Only `false` is the public opt-out; every other "effectively absent" value
  // is rejected: `undefined`, `null`, an empty string, and an EMPTY ARRAY. The
  // empty array is the dangerous one: `authEnabled ? [auth] : []` would
  // otherwise mount the admin API public silently while looking guarded.
  if (isAbsentAdminMiddleware(middleware)) {
    throw new Error(
      'multitenancyAdminRoutes: `middleware` is required. The admin API exposes destructive ' +
        'routes (tenant destroy, impersonation, SSO config), so it refuses to mount without auth. ' +
        'Pass your auth middleware, e.g. `multitenancyAdminRoutes({ middleware: middleware.adminAuth() })`. ' +
        'To intentionally mount it public (only behind a trusted network boundary), pass `middleware: false`.'
    )
  }

  // `false` is the explicit "mount public" opt-out; anything else is real middleware.
  const guarded = middleware !== false

  if (resolveAdminActor) {
    __setAdminActorResolver(resolveAdminActor)
  }

  const define = () => {
    const c = new AdminController()
    router.get('/tenants', (ctx) => c.list(ctx))
    router.post('/tenants', (ctx) => c.create(ctx))
    router.get('/tenants/:id', (ctx) => c.show(ctx))
    router.post('/tenants/:id/activate', (ctx) => c.activate(ctx))
    router.post('/tenants/:id/suspend', (ctx) => c.suspend(ctx))
    router.post('/tenants/:id/destroy', (ctx) => c.destroy(ctx))
    router.post('/tenants/:id/restore', (ctx) => c.restore(ctx))
    router.get('/tenants/:id/queue/stats', (ctx) => c.queueStats(ctx))
    router.post('/tenants/:id/maintenance', (ctx) => c.enterMaintenance(ctx))
    router.delete('/tenants/:id/maintenance', (ctx) => c.exitMaintenance(ctx))
    router.post('/tenants/:id/impersonations', (ctx) => c.startImpersonation(ctx))
    router.delete('/impersonations/:token', (ctx) => c.stopImpersonation(ctx))
    router.delete('/impersonations/by-id/:sessionId', (ctx) => c.stopImpersonation(ctx))
    router.get('/health/report', (ctx) => c.healthReport(ctx))

    // Satellite resources: one controller each. Instantiated per-call so
    // they pick up container-bound dependencies on every request (a wash in
    // performance for admin volume).
    const audit = new AuditLogsController()
    router.get('/tenants/:id/audit-logs', (ctx) => audit.list(ctx))

    const wh = new WebhooksController()
    router.get('/tenants/:id/webhooks', (ctx) => wh.list(ctx))
    router.post('/tenants/:id/webhooks', (ctx) => wh.create(ctx))
    router.put('/tenants/:id/webhooks/:webhookId', (ctx) => wh.update(ctx))
    router.delete('/tenants/:id/webhooks/:webhookId', (ctx) => wh.destroy(ctx))
    router.get('/tenants/:id/webhooks/:webhookId/deliveries', (ctx) => wh.listDeliveries(ctx))
    router.post('/tenants/:id/webhooks/deliveries/:deliveryId/retry', (ctx) =>
      wh.retryDelivery(ctx)
    )

    const ff = new FeatureFlagsController()
    router.get('/tenants/:id/feature-flags', (ctx) => ff.list(ctx))
    router.post('/tenants/:id/feature-flags', (ctx) => ff.create(ctx))
    router.put('/tenants/:id/feature-flags/:flagKey', (ctx) => ff.update(ctx))
    router.delete('/tenants/:id/feature-flags/:flagKey', (ctx) => ff.destroy(ctx))

    const br = new BrandingController()
    router.get('/tenants/:id/branding', (ctx) => br.show(ctx))
    router.put('/tenants/:id/branding', (ctx) => br.update(ctx))

    const sso = new SsoController()
    router.get('/tenants/:id/sso', (ctx) => sso.show(ctx))
    router.put('/tenants/:id/sso', (ctx) => sso.update(ctx))
    router.post('/tenants/:id/sso/disable', (ctx) => sso.disable(ctx))

    const metrics = new MetricsController()
    router.get('/tenants/:id/metrics', (ctx) => metrics.list(ctx))

    const quotas = new QuotasController()
    router.get('/tenants/:id/quotas', (ctx) => quotas.show(ctx))
    router.put('/tenants/:id/quotas/usage', (ctx) => quotas.setUsage(ctx))
    router.post('/tenants/:id/quotas/reset', (ctx) => quotas.reset(ctx))

    // Host-registered custom actions. `contract-version` + `actions` are GET and
    // `dispatch` is POST, so the static GET paths never collide with `:name`.
    const actions = new AdminActionsController(actionGuards)
    router.get('/actions', (ctx) => actions.list(ctx))
    router.get('/actions/contract-version', (ctx) => actions.contractVersion(ctx))
    router.post('/actions/:name', (ctx) => actions.dispatch(ctx))
  }

  const group = router.group(define)
  if (prefix) group.prefix(prefix)
  if (guarded) (group as any).use(middleware)

  // Documentation routes mount as a sibling group so we can opt them out of
  // `middleware` by default. Lazy-import openapi/swagger to avoid loading
  // them when the consumer never hits the docs paths.
  const docsDefine = () => {
    router.get('/openapi.json', async (ctx) => {
      const { getOpenAPISpec } = await import('./openapi.js')
      return ctx.response.ok(getOpenAPISpec(prefix))
    })
    router.get('/docs', async (ctx) => {
      const { renderSwaggerHtml } = await import('./swagger_html.js')
      ctx.response.type('text/html')
      return ctx.response.send(renderSwaggerHtml(`${prefix}/openapi.json`))
    })
  }
  const docsGroup = router.group(docsDefine)
  if (prefix) docsGroup.prefix(prefix)
  if (docsAuth && guarded) (docsGroup as any).use(middleware)
}
