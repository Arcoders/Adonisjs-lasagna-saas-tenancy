import router from '@adonisjs/core/services/router'
import server from '@adonisjs/core/services/server'

server.use([() => import('@adonisjs/core/bodyparser_middleware')])

// Minimal error handler so package `Exception` subclasses (which carry a real
// `.status`) round-trip with their intended status instead of a generic 500.
// AdonisJS only loads its default handler in full app builds; the bench app
// skips it.
class BenchErrorHandler {
  async handle(error: any, ctx: any) {
    const status =
      typeof error?.status === 'number' && error.status >= 100 && error.status < 600
        ? error.status
        : 500
    return ctx.response.status(status).send({ error: error?.message ?? String(error), code: error?.code })
  }
  async report() {}
}
server.errorHandler(async () => ({ default: BenchErrorHandler }))

export const middleware = router.named({
  tenantGuard: () =>
    import('@adonisjs-lasagna/saas-tenancy/middleware').then((m) => ({
      default: m.TenantGuardMiddleware,
    })),
  rateLimit: () =>
    import('@adonisjs-lasagna/saas-tenancy/middleware').then((m) => ({
      default: m.RateLimitMiddleware,
    })),
})
