import { timingSafeEqual } from 'node:crypto'
import { getConfig } from '../config.js'
import CircuitOpenException from '../exceptions/circuit_open_exception.js'
import TenantNotReadyException from '../exceptions/tenant_not_ready_exception.js'
import TenantSuspendedException from '../exceptions/tenant_suspended_exception.js'
import TenantAccessForbiddenException from '../exceptions/tenant_access_forbidden_exception.js'
import TenantMaintenanceException from '../exceptions/tenant_maintenance_exception.js'
import CircuitBreakerService from '../services/circuit_breaker_service.js'
import { tenancy } from '../tenancy.js'
import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

export default class TenantGuardMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const { request } = ctx
    const path = request.url(false).split('?')[0]
    const ignored = getConfig().ignorePaths.some((p) => path === p || path.startsWith(`${p}/`))
    if (ignored) return next()

    const tenant = await request.tenant()

    if (tenant.isSuspended || tenant.isDeleted) {
      throw new TenantSuspendedException()
    }

    // Membership gate (opt-in). The package routes by tenant id and verifies the
    // tenant exists and is active, but it never checks that the authenticated
    // caller belongs to this tenant; that is the host's job. Run it before the
    // operational checks below so a non-member is rejected with a 403 without
    // probing the tenant's provisioning/maintenance/circuit state. (Suspended and
    // soft-deleted tenants are already rejected above by the lifecycle floor, so
    // their 403 is observable independently of this gate.)
    const authorize = getConfig().authorizeTenantAccess
    if (authorize && !(await authorize(ctx, tenant))) {
      throw new TenantAccessForbiddenException()
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

    // Bind the tenant log context AND run the bootstrapper enter/leave
    // lifecycle for the request (a bare logCtx.run skipped bootstrappers on the
    // HTTP path, so a custom isolation bootstrapper silently no-opped here while
    // working in jobs).
    return tenancy.runForRequest(tenant, request, () => next())
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
