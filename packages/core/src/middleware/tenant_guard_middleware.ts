import { timingSafeEqual } from 'node:crypto'
import { getConfig } from '../config.js'
import CircuitOpenException from '../exceptions/circuit_open_exception.js'
import TenantNotReadyException from '../exceptions/tenant_not_ready_exception.js'
import TenantSuspendedException from '../exceptions/tenant_suspended_exception.js'
import TenantMaintenanceException from '../exceptions/tenant_maintenance_exception.js'
import CircuitBreakerService from '../services/circuit_breaker_service.js'
import TenantLogContext from '../services/tenant_log_context.js'
import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

export default class TenantGuardMiddleware {
  async handle({ request }: HttpContext, next: NextFn) {
    const path = request.url(false).split('?')[0]
    const ignored = getConfig().ignorePaths.some((p) => path === p || path.startsWith(`${p}/`))
    if (ignored) return next()

    const tenant = await request.tenant()

    if (tenant.isSuspended || tenant.isDeleted) {
      throw new TenantSuspendedException()
    }

    if (tenant.isProvisioning || tenant.isFailed) {
      throw new TenantNotReadyException()
    }

    if (tenant.isMaintenance && !this.#hasMaintenanceBypass(request)) {
      const cfg = getConfig().maintenance
      const exc = new TenantMaintenanceException()
      exc.retryAfterSeconds = cfg?.retryAfterSeconds ?? 600
      exc.tenantMessage = tenant.maintenanceMessage ?? cfg?.defaultMessage ?? null
      throw exc
    }

    const cbService = await app.container.make(CircuitBreakerService)
    if (cbService.isOpen(tenant.id)) {
      throw new CircuitOpenException()
    }

    const logCtx = await app.container.make(TenantLogContext)
    return logCtx.run({ tenantId: tenant.id }, () => next())
  }

  #hasMaintenanceBypass(request: HttpContext['request']): boolean {
    const cfg = getConfig().maintenance
    if (!cfg?.bypassToken) return false
    const headerName = cfg.bypassHeader ?? 'x-tenant-bypass-maintenance'
    const presented = request.header(headerName)
    if (typeof presented !== 'string') return false
    // Constant-time compare to keep the secret out of timing side channels.
    // The length-prefix check is necessary because timingSafeEqual throws
    // on length mismatch — but doing it explicitly still leaks length, which
    // is acceptable for a fixed-size operator-rotated token.
    const a = Buffer.from(presented)
    const b = Buffer.from(cfg.bypassToken)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }
}
