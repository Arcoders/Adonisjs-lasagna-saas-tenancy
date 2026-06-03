import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import TenantLogContext from './tenant_log_context.js'

/**
 * Returns the AdonisJS root logger wrapped with the active tenant context
 * (if any). Inside an HTTP request handled by `TenantGuardMiddleware` or a
 * tenant queue job, log lines automatically carry `{ tenantId }`.
 *
 * Outside any tenant context, this returns the plain root logger.
 */
export async function tenantLogger() {
  const ctx = await app.container.make(TenantLogContext)
  return ctx.bind(logger as any)
}
