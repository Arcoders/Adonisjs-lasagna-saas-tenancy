import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import { TenantLogContext, tenantLogger } from '@adonisjs-lasagna/saas-tenancy/services'

/**
 * Probe used by the contextual_logging e2e spec. The TenantGuardMiddleware
 * wraps the request body in `TenantLogContext.run({ tenantId })`, so:
 *   - `currentTenantId()` returns the resolved id from AsyncLocalStorage
 *   - the Pino child returned by `tenantLogger()` carries the same binding
 *
 * We reflect both back to the caller so the test can assert that the
 * AsyncLocalStorage value matches `request.tenant().id` AND that the logger
 * automatically inherits the binding (i.e. no manual wiring required).
 */
@inject()
export default class LogController {
  constructor(private readonly logContext: TenantLogContext) {}

  async emit({ request, response }: HttpContext) {
    const tenant = await request.tenant()
    const log = await tenantLogger()

    log.info({ source: 'log/emit' }, 'tenant context probe')

    return response.ok({
      ok: true,
      tenantId: tenant.id,
      contextTenantId: this.logContext.currentTenantId() ?? null,
      loggerBindings: readPinoBindings(log),
    })
  }
}

/**
 * Pino exposes `bindings()` only on child loggers. We return whatever it
 * gives us so the test can match on the `tenantId` key without hard-coding
 * the rest of the binding shape.
 */
function readPinoBindings(log: unknown): Record<string, unknown> | null {
  const candidate = (log as { bindings?: () => Record<string, unknown> }).bindings
  if (typeof candidate !== 'function') return null
  try {
    return candidate.call(log) ?? null
  } catch {
    return null
  }
}
