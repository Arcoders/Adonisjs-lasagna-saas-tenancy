import type { TenantModelContract, TenantRepositoryContract } from '../types/contracts.js'
import { resolveTenantRepository } from '../services/resolve_tenant_repository.js'
import {
  resolveTenant,
  __setMemoizedTenant,
  dependencyUnavailable,
  hasDecidedHttpStatus,
  mapTenantQueryError,
  findTenantByIdCached,
} from '../extensions/request.js'
import { getActiveDriver } from '../services/isolation/active_driver.js'
import { isUuidV4 } from '../services/isolation/identifier.js'
import CircuitBreakerService from '../services/circuit_breaker_service.js'
import CircuitOpenException from '../exceptions/circuit_open_exception.js'
import { tenancy } from '../tenancy.js'
import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

/**
 * Universal routes: try to resolve a tenant, but fall through cleanly when
 * there isn't one. When a tenant IS resolved, behave like the tenant guard
 * (memoize, attach log context, connect the driver). When it isn't, just
 * call `next()` so the same handler can serve both contexts.
 *
 * Unlike `TenantGuardMiddleware`, this middleware does not throw on a missing,
 * invalid, or genuinely absent tenant — it silently degrades to "central" mode.
 * Suspended / deleted / not-ready tenants are also passed through as if they
 * didn't exist; the route handler decides what to render without a tenant.
 *
 * What it does NOT swallow: when a tenant IS named (a valid id/domain) but
 * loading or connecting it fails for an infrastructure reason — the registry
 * lookup throws (central DB down), the driver connect fails (tenant DB down),
 * the hard cap is hit, or a 500-class misconfiguration surfaces — it fails
 * closed (the underlying 503/500) rather than degrading. Serving a
 * tenant-targeted request in central mode would hand it a request without its
 * own data context, the isolation footgun this package exists to prevent. A
 * lookup that simply returns null (tenant doesn't exist) still degrades.
 */
export default class UniversalMiddleware {
  async handle({ request }: HttpContext, next: NextFn) {
    const tenant = await this.#tryResolve(request)
    if (!tenant) return next()

    // Bind the tenant log context AND run the bootstrapper enter/leave
    // lifecycle for the request, matching the guarded path and the background
    // tenancy.run() path. A tenant backend severed mid-handler maps to a clean
    // 503 (Postgres has already rolled the aborted transaction back), matching
    // the guarded path; ordinary handler errors pass through.
    try {
      return await tenancy.runForRequest(tenant, request, () => next())
    } catch (err) {
      throw mapTenantQueryError(err, tenant.id)
    }
  }

  async #tryResolve(request: HttpContext['request']): Promise<TenantModelContract | null> {
    let result
    try {
      result = await resolveTenant(request)
    } catch (err) {
      await warn('resolver_failed', err)
      return null
    }
    if (!result) return null

    let repo: TenantRepositoryContract | null = null
    try {
      repo = await resolveTenantRepository()
    } catch {
      // Repo isn't bound (typical in unit tests / early boot). Silent: this
      // is expected, not a degradation.
      return null
    }
    if (!repo) return null

    let tenant: TenantModelContract | null = null
    try {
      if (result.type === 'id') {
        if (!isUuidV4(result.tenantId)) return null
        // Pass includeDeleted=false to preserve the exact legacy behaviour when
        // the cache is off. When the cache is on, the shared entry is the deleted
        // -inclusive superset and the isSuspended/isDeleted checks below still
        // degrade a soft-deleted tenant to null.
        tenant = await findTenantByIdCached(repo, result.tenantId, false)
      } else if (result.type === 'domain') {
        tenant = await repo.findByDomain(result.domain)
      }
    } catch (err) {
      // The request named a tenant but the registry lookup threw (central DB
      // down, etc.). Degrading to central here would serve a tenant-targeted
      // request without its data context, so fail closed instead. Respect a
      // decided HTTP status; map a raw outage to a 503 — consistent with
      // `request.tenant()`. (A genuinely absent tenant returns null below and
      // still degrades to central, per the "as if it didn't exist" contract.)
      if (hasDecidedHttpStatus(err)) throw err
      throw dependencyUnavailable(
        'tenant.lookup',
        err,
        result.type === 'id' ? result.tenantId : undefined
      )
    }

    if (!tenant) return null
    if (tenant.isSuspended || tenant.isDeleted) return null
    if (tenant.isProvisioning || tenant.isFailed) return null

    // Drive the tenant breaker so universal-route traffic trips it too. A named
    // tenant whose DB is failing must fail closed (503), never degrade to
    // central — that would serve a tenant-targeted request without its data.
    const cbService = await app.container.make(CircuitBreakerService)
    try {
      await cbService.run(tenant.id)
    } catch (err) {
      if (cbService.isOpen(tenant.id) || cbService.isOpenRejection(err)) {
        throw new CircuitOpenException()
      }
      if (hasDecidedHttpStatus(err)) throw err
      throw dependencyUnavailable('tenant.circuit_probe', err, tenant.id)
    }

    try {
      const driver = await getActiveDriver()
      await driver.connect(tenant)
    } catch (err) {
      // The tenant resolved fine; only its backend connection failed. Fail
      // closed rather than degrade to central. Respect a decided HTTP status
      // (the hard-cap 503, or a 500-class config fault); map any other connect
      // failure (Postgres down, etc.) to a clean 503 — consistent with
      // `request.tenant()`.
      if (hasDecidedHttpStatus(err)) throw err
      throw dependencyUnavailable('tenant.connect', err, tenant.id)
    }
    __setMemoizedTenant(request, tenant)
    return tenant
  }
}

/**
 * Best-effort warn: if the logger isn't available (early boot, unit tests),
 * fall back to stderr. We never let logging itself break the middleware.
 */
async function warn(kind: string, err: unknown): Promise<void> {
  try {
    const logger = await app.container.make('logger').catch(() => undefined)
    const message = (err as any)?.message ?? String(err)
    if (logger) {
      logger.warn(
        { middleware: 'universal', kind, error: message },
        'multitenancy: universal middleware swallowed an error and degraded to central mode'
      )
      return
    }
  } catch {
    // ignore
  }
  console.warn(
    `[multitenancy] universal middleware degraded (${kind}):`,
    (err as any)?.message ?? err
  )
}
