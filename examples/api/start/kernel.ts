import router from '@adonisjs/core/services/router'
import server from '@adonisjs/core/services/server'

// Without this registration the handler in app/exceptions/handler.ts is dead
// code and every error renders through the http-server's built-in fallback
// (plain-text message, no JSON shape, no delegation to an exception's own
// handle(), which is what sets Retry-After on maintenance 503s).
server.errorHandler(() => import('#app/exceptions/handler'))

server.use([() => import('@adonisjs/core/bodyparser_middleware')])

// Initializes `ctx.auth` on every request (and, once imported, activates the
// `ctx.auth` module augmentation project-wide). Both realms hang off it: the
// named `auth` middleware below and the membership authorizer's
// `auth.use('tenant').check()` need it in place before route middleware runs.
router.use([() => import('@adonisjs/auth/initialize_auth_middleware')])

export const middleware = router.named({
  tenantGuard: () =>
    import('@adonisjs-lasagna/saas-tenancy/middleware').then((m) => ({
      default: m.TenantGuardMiddleware,
    })),
  customDomain: () =>
    import('@adonisjs-lasagna/saas-tenancy/middleware').then((m) => ({
      default: m.CustomDomainMiddleware,
    })),
  rateLimit: () =>
    import('@adonisjs-lasagna/saas-tenancy/middleware').then((m) => ({
      default: m.RateLimitMiddleware,
    })),
  trackMetrics: () =>
    import('@adonisjs-lasagna/saas-tenancy/middleware').then((m) => ({
      default: m.TrackMetricsMiddleware,
    })),
  impersonation: () =>
    import('@adonisjs-lasagna/saas-tenancy/middleware').then((m) => ({
      default: m.ImpersonationMiddleware,
    })),
  auth: () => import('#app/middleware/auth_middleware'),
})
