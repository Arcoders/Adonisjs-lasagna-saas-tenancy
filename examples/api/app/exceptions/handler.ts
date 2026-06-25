import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
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

// TENANT_503_DIAG=1 → append JSONL records for every 5xx (and unmapped
// errors) to TENANT_503_DIAG_LOG (default storage/503-diag.log).
const diagPath = (() => {
  if (process.env.TENANT_503_DIAG !== '1') return null
  const raw = process.env.TENANT_503_DIAG_LOG ?? 'storage/503-diag.log'
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw)
})()

async function diag(line: Record<string, unknown>) {
  if (!diagPath) return
  try {
    await mkdir(dirname(diagPath), { recursive: true })
    await appendFile(diagPath, JSON.stringify({ at: new Date().toISOString(), ...line }) + '\n')
  } catch {
    /* diagnostic only — never break the response */
  }
}

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
    if (error instanceof TenantAccessForbiddenException) {
      return ctx.response.status(403).send({
        error: { code: 'TENANT_ACCESS_FORBIDDEN', message: 'Not authorized for this tenant' },
      })
    }
    if (error instanceof TenantNotReadyException) {
      await diag({
        kind: 'TENANT_NOT_READY',
        url: ctx.request.url(true),
        method: ctx.request.method(),
        tenantHeader: ctx.request.header('x-tenant-id') ?? null,
      })
      return ctx.response.status(503).send({
        error: { code: 'TENANT_NOT_READY', message: 'Tenant is still provisioning' },
      })
    }
    if (error instanceof CircuitOpenException) {
      await diag({
        kind: 'CIRCUIT_OPEN',
        url: ctx.request.url(true),
        method: ctx.request.method(),
        tenantHeader: ctx.request.header('x-tenant-id') ?? null,
      })
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
    // Log unmapped errors too (TenantMaintenance, RateLimitUnavailable,
    // raw Lucid/Pg) before falling through to super.
    await diag({
      kind: 'UNHANDLED',
      errorName: (error as Error)?.constructor?.name ?? typeof error,
      errorMessage: (error as Error)?.message ?? String(error),
      status: (error as { status?: number })?.status ?? null,
      url: ctx.request.url(true),
      method: ctx.request.method(),
      tenantHeader: ctx.request.header('x-tenant-id') ?? null,
    })
    return super.handle(error, ctx)
  }

  async report(error: unknown, ctx: HttpContext) {
    return super.report(error, ctx)
  }
}
