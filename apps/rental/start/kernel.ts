import router from '@adonisjs/core/services/router'
import server from '@adonisjs/core/services/server'

// Register this app's exception handler so typed multitenancy exceptions render
// as friendly JSON (and maintenance 503s carry Retry-After) instead of the
// http-server's plain-text fallback.
server.errorHandler(() => import('#app/exceptions/handler'))

// Server-level middleware runs on every request BEFORE routing. The Vite
// middleware has to live here (not in `router.use`) so it can intercept asset
// requests (`/@vite/client`, `/inertia/app/app.tsx`, hashed bundles) and proxy
// them to the in-process dev server — those paths match no route, so a
// router-level registration would 404 them before the middleware ever ran.
server.use([
  () => import('@adonisjs/vite/vite_middleware'),
  () => import('@adonisjs/core/bodyparser_middleware'),
])

// The per-request browser + auth chain, in dependency order:
//   session   → so ctx.session exists for the `web-*` guards and Inertia flash
//   auth init → so ctx.auth exists (both token and session guards hang off it)
//   inertia   → attaches ctx.inertia and shares props with every page
// Session must precede auth init because the membership gate's
// `auth.use('web-tenant').check()` reads the session during route middleware.
router.use([
  () => import('@adonisjs/session/session_middleware'),
  () => import('@adonisjs/auth/initialize_auth_middleware'),
  () => import('#app/middleware/inertia_middleware'),
])

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
  webAuth: () => import('#app/middleware/web_auth_middleware'),
})
