import app from '@adonisjs/core/services/app'
import { ExceptionHandler, type HttpContext } from '@adonisjs/core/http'
import {
  MissingTenantHeaderException,
  TenantNotFoundException,
  TenantSuspendedException,
  TenantAccessForbiddenException,
  TenantNotReadyException,
  CircuitOpenException,
  QuotaExceededException,
} from '@adonisjs-lasagna/saas-tenancy/exceptions'

/**
 * Maps every typed exception the package can raise to a friendly JSON response.
 * The `{ error: { code, message, details? } }` shape is consistent across the
 * whole API surface. Inertia responses render through the framework's own
 * handler (this only shapes the JSON/API and typed-503 paths).
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
        error: { code: 'TENANT_NOT_FOUND', message: 'Company does not exist' },
      })
    }
    if (error instanceof TenantSuspendedException) {
      return ctx.response.status(403).send({
        error: { code: 'TENANT_SUSPENDED', message: 'Company is suspended' },
      })
    }
    if (error instanceof TenantAccessForbiddenException) {
      return ctx.response.status(403).send({
        error: { code: 'TENANT_ACCESS_FORBIDDEN', message: 'Not authorized for this company' },
      })
    }
    if (error instanceof TenantNotReadyException) {
      return ctx.response.status(503).send({
        error: { code: 'TENANT_NOT_READY', message: 'Company is still provisioning' },
      })
    }
    if (error instanceof CircuitOpenException) {
      return ctx.response.status(503).send({
        error: { code: 'CIRCUIT_OPEN', message: 'Company circuit breaker is open — try later' },
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
