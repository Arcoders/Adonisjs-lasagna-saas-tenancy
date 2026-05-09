import router from '@adonisjs/core/services/router'
import server from '@adonisjs/core/services/server'

server.use([() => import('@adonisjs/core/bodyparser_middleware')])

// Custom handler so the package's `Exception` subclasses (which carry a
// proper `.status`) round-trip to the HTTP response with their intended
// status code. AdonisJS's default ExceptionHandler is only loaded by
// production apps; the fixture skips it, and without this we'd surface
// every raised exception as a generic 500.
class FixtureErrorHandler {
  async handle(error: any, ctx: any) {
    const status =
      typeof error?.status === 'number' && error.status >= 100 && error.status < 600
        ? error.status
        : 500
    return ctx.response.status(status).send({
      error: error?.message ?? String(error),
      code: error?.code,
    })
  }
  async report() {}
}
server.errorHandler(async () => ({ default: FixtureErrorHandler }))

export const middleware = router.named({
  tenantGuard: () =>
    import('@adonisjs-lasagna/saas-tenancy/middleware').then((m) => ({
      default: m.TenantGuardMiddleware,
    })),
  customDomain: () =>
    import('@adonisjs-lasagna/saas-tenancy/middleware').then((m) => ({
      default: m.CustomDomainMiddleware,
    })),
})
