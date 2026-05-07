import router from '@adonisjs/core/services/router'
import server from '@adonisjs/core/services/server'

server.use([() => import('@adonisjs/core/bodyparser_middleware')])

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
  demoAdminAuth: () => import('#app/middleware/demo_admin_auth_middleware'),
})
