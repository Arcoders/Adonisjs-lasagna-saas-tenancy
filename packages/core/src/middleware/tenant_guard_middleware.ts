import { timingSafeEqual } from 'node:crypto'
import { getConfig } from '../config.js'
import CircuitOpenException from '../exceptions/circuit_open_exception.js'
import DependencyUnavailableException from '../exceptions/dependency_unavailable_exception.js'
import TenantNotReadyException from '../exceptions/tenant_not_ready_exception.js'
import TenantSuspendedException from '../exceptions/tenant_suspended_exception.js'
import TenantAccessForbiddenException from '../exceptions/tenant_access_forbidden_exception.js'
import TenantMaintenanceException from '../exceptions/tenant_maintenance_exception.js'
import CircuitBreakerService from '../services/circuit_breaker_service.js'
import { mapTenantQueryError } from '../extensions/request.js'
import { tenancy } from '../tenancy.js'
import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

/**
 * HTTP middleware that gates every tenant-scoped request. It skips configured
 * ignore paths, resolves the current tenant, and rejects suspended or deleted
 * tenants. It then runs the optional authorizeTenantAccess membership check
 * (403 on failure), refuses provisioning or failed tenants, and enforces
 * maintenance mode unless a constant-time-compared bypass token is presented.
 * It drives the circuit breaker with a connectivity probe so repeated tenant-DB
 * failures can trip it, mapping an open breaker to a circuit exception and a
 * still-closed probe failure to a 503. Finally it binds the tenant log context
 * and bootstrapper lifecycle while running the next handler, translating a
 * severed tenant backend into a clean dependency-unavailable error.
 */
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

    // Drive the breaker, don't just read it: firing the connectivity probe
    // THROUGH the breaker is what lets repeated tenant-DB failures trip it
    // (a passive isOpen() read never accumulates failures, so the breaker could
    // never open). An already-OPEN breaker fast-fails here without probing.
    const cbService = await app.container.make(CircuitBreakerService)
    try {
      await cbService.run(tenant.id)
    } catch (err) {
      if (cbService.isOpen(tenant.id) || cbService.isOpenRejection(err)) {
        throw new CircuitOpenException()
      }
      // Probe failed while still CLOSED/HALF_OPEN (tenant DB unreachable but the
      // breaker has not tripped yet): a clean 503 rather than an opaque 500.
      throw new DependencyUnavailableException({
        dependency: 'postgres',
        operation: 'tenant.circuit_probe',
        tenantId: tenant.id,
      })
    }

    // Bind the tenant log context AND run the bootstrapper enter/leave
    // lifecycle for the request (a bare logCtx.run skipped bootstrappers on the
    // HTTP path, so a custom isolation bootstrapper silently no-opped here while
    // working in jobs). A tenant backend severed mid-handler (failover, admin
    // termination, crash) is mapped to a clean 503 instead of a raw Lucid 500;
    // Postgres has already rolled the aborted transaction back, so no partial
    // write survives. Ordinary handler errors pass straight through.
    try {
      return await tenancy.runForRequest(tenant, request, () => next())
    } catch (err) {
      throw mapTenantQueryError(err, tenant.id)
    }
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
