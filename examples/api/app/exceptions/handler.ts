import app from '@adonisjs/core/services/app'
import { ExceptionHandler, HttpContext } from '@adonisjs/core/http'
import {
  MissingTenantHeaderException,
  TenantNotFoundException,
  TenantSuspendedException,
  TenantNotReadyException,
  CircuitOpenException,
  QuotaExceededException,
} from '@adonisjs-lasagna/saas-tenancy/exceptions'

/**
 * Maps every typed exception the package can raise to a friendly JSON response.
 * The shape `{ error: { code, message, details? } }` is consistent across all
 * /demo routes and matches what API consumers usually expect.
 */
export default class HttpExceptionHandler extends ExceptionHandler {
  protected debug = !app.inProduction

  async handle(error: unknown, ctx: HttpContext) {
    if (error instanceof MissingTenantHeaderException) {
      return ctx.response.status(400).send({
        error: { code: 'MISSING_TENANT_HEADER', message: 'No tenant identifier in request' },
      })
    }
    if (error instanceof TenantNotFoundException) {
      return ctx.response.status(404).send({
        error: { code: 'TENANT_NOT_FOUND', message: 'Tenant does not exist' },
      })
    }
    if (error instanceof TenantSuspendedException) {
      return ctx.response.status(403).send({
        error: { code: 'TENANT_SUSPENDED', message: 'Tenant is suspended' },
      })
    }
    if (error instanceof TenantNotReadyException) {
      return ctx.response.status(503).send({
        error: { code: 'TENANT_NOT_READY', message: 'Tenant is still provisioning' },
      })
    }
    if (error instanceof CircuitOpenException) {
      return ctx.response.status(503).send({
        error: { code: 'CIRCUIT_OPEN', message: 'Tenant circuit breaker is open — try later' },
      })
    }
    if (error instanceof QuotaExceededException) {
      ctx.response.header('Retry-After', '60')
      return ctx.response.status(429).send({
        error: {
          code: 'QUOTA_EXCEEDED',
          message: error.message,
          details: {
            quota: error.quota,
            limit: error.limit,
            current: error.current,
            attempted: error.attempted,
          },
        },
      })
    }
    return super.handle(error, ctx)
  }

  async report(error: unknown, ctx: HttpContext) {
    return super.report(error, ctx)
  }
}
