import app from '@adonisjs/core/services/app'
import ImpersonationService from '../services/impersonation_service.js'
import ImpersonationInvalidException from '../exceptions/impersonation_invalid_exception.js'
import { getConfig } from '../config.js'
import { tenancy } from '../tenancy.js'
import { resolveTenant } from '../extensions/request.js'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract } from '../types/contracts.js'
import type { TenantResolveResult } from '../services/resolvers/resolver.js'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

const DEFAULT_HEADER = 'x-impersonation-token'
const DEFAULT_COOKIE = '__impersonation'

/**
 * Verifies an impersonation token (header or cookie) and attaches the
 * derived context to `ctx.impersonation`. Invalid tokens throw 401 —
 * soft failure would let attackers probe with random tokens.
 */
export default class ImpersonationMiddleware {
  // Method seam (not constructor injection) because the named-middleware
  // factory resolves this class via the IoC container, and the container
  // can't inject ImpersonationService without a config-validated boot.
  protected getService(): Promise<ImpersonationService> {
    return app.container.make(ImpersonationService)
  }

  /** Test seam: the tenant id already active in scope (set by the guard). */
  protected currentTenantId(): string | undefined {
    return tenancy.currentId()
  }

  /** Test seam: resolve the request's tenant (id or domain envelope). */
  protected resolveRequestTenant(ctx: HttpContext): Promise<TenantResolveResult> {
    return resolveTenant(ctx.request)
  }

  /** Test seam: the host's tenant repository (for the by-domain canonical id). */
  protected getRepository(): Promise<TenantRepositoryContract> {
    return app.container.make(TENANT_REPOSITORY as any) as Promise<TenantRepositoryContract>
  }

  async handle(ctx: HttpContext, next: NextFn) {
    const cfg = getConfig().impersonation
    const headerName = cfg?.headerName ?? DEFAULT_HEADER
    const cookieName = cfg?.cookieName ?? DEFAULT_COOKIE

    const fromHeader = ctx.request.header(headerName)
    const fromCookie = (ctx.request as any).cookie?.(cookieName)
    const token = (fromHeader ?? fromCookie) as string | null | undefined

    if (!token) return next()

    const svc = await this.getService()
    const verified = await svc.verify(token)
    if (!verified) throw new ImpersonationInvalidException()

    // Bind the token to the request's tenant. A token issued for tenant A
    // presented on tenant B's request must not attach an A-scoped context to B.
    //
    // Prefer the canonical id the guard already resolved (`tenancy.currentId()`),
    // but do not DEPEND on the guard having run first: if no context is active
    // (this middleware ran before the guard, or in isolation), resolve the
    // request's tenant ourselves.
    //   - `id`-typed resolution: the value is the canonical UUID (the
    //     `request.tenant()` macro asserts it), so compare directly.
    //   - `domain`-typed resolution (custom domains): the request DOES name a
    //     tenant, just by host. We must resolve it to its canonical id and bind,
    //     otherwise domain resolution would silently bypass the check (P1-2) — an
    //     A-token would attach on B's domain. If the host maps to no tenant there
    //     is nothing to bind (treated like a central route). If the lookup itself
    //     fails we cannot prove the token matches the surface, so we fail closed.
    //   - no resolution (genuine central route): nothing to bind to; allow.
    let boundTenantId = this.currentTenantId()
    if (!boundTenantId) {
      let resolved: TenantResolveResult | undefined
      try {
        resolved = await this.resolveRequestTenant(ctx)
      } catch {
        resolved = undefined
      }
      if (resolved?.type === 'id') {
        boundTenantId = resolved.tenantId
      } else if (resolved?.type === 'domain') {
        try {
          const repo = await this.getRepository()
          const tenant = await repo.findByDomain(resolved.domain)
          boundTenantId = tenant?.id
        } catch {
          // A tenant is being addressed by domain but we couldn't resolve it to
          // verify the token's binding. Fail closed rather than accept blindly.
          throw new ImpersonationInvalidException()
        }
      }
    }
    if (boundTenantId && boundTenantId !== verified.tenantId) {
      throw new ImpersonationInvalidException()
    }

    ctx.impersonation = verified
    return next()
  }
}
