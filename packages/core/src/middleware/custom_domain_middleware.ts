import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract } from '../types/contracts.js'
import TenantHeaderDomainMismatchException from '../exceptions/tenant_header_domain_mismatch_exception.js'
import { getConfig } from '../config.js'
import { primeResolvedTenant } from '../extensions/request.js'
import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

export interface CustomDomainOptions {
  /**
   * When `strict` is true (the default) and both a `Host` matching a custom
   * domain AND an `x-tenant-id` header are present, the request is REJECTED
   * with 400 unless they agree. The verified domain is authoritative; letting
   * a header override it is a tenant-hop vector if your CDN/edge fixes Host
   * but passes through arbitrary headers.
   *
   * Set to `false` only if you intentionally route by header on hosts the
   * package also manages as custom domains (the pre-1.0 behavior, where an
   * explicit header won without consulting the domain). Understand the
   * trade-off before opting out: any caller able to set the header can then
   * address a different tenant through a verified domain.
   */
  strict?: boolean
}

export default class CustomDomainMiddleware {
  // Method seam (not constructor injection) because the named-middleware
  // factory resolves this class via the IoC container. The default resolves
  // the host-bound repository from the container; tests override it.
  protected getRepository(): Promise<TenantRepositoryContract> {
    return app.container.make(TENANT_REPOSITORY as any) as Promise<TenantRepositoryContract>
  }

  async handle({ request }: HttpContext, next: NextFn, options: CustomDomainOptions = {}) {
    // Secure by default: the verified domain is authoritative. Opt out only by
    // passing `strict: false` explicitly (the legacy header-wins behavior).
    const strict = options.strict ?? true
    // Use the configured tenant header so the Host->tenant hand-off matches what
    // the resolver reads downstream (getConfig().tenantHeaderKey), rather than a
    // fixed 'x-tenant-id'. Raw Node headers are lower-cased, so the auto-fill
    // writes the lower-cased key (the default is already lower-case).
    const headerKey = getConfig().tenantHeaderKey
    const host = request.header('host')?.split(':')[0]
    const headerTenantId = request.header(headerKey)

    if (!host) return next()

    if (headerTenantId && !strict) {
      // Legacy (opt-in) behavior: an explicit header wins, even if it disagrees
      // with the Host. Document and skip.
      return next()
    }

    const repo = await this.getRepository()
    const tenant = await repo.findByDomain(host)

    if (!tenant) {
      // No tenant claims this Host. If the caller also sent a header,
      // we let it through unchanged — that's how header-based routing
      // works for hosts the package doesn't manage. In strict mode this
      // is still acceptable: a request without a domain claim cannot
      // mismatch a domain.
      return next()
    }

    if (headerTenantId && strict && headerTenantId !== tenant.id) {
      // Both signals are present and they disagree. Reject — the safer
      // failure mode is "no service" rather than "service for whichever
      // side the attacker controls".
      throw new TenantHeaderDomainMismatchException()
    }

    // Either the header agrees with the domain (strict pass-through), or
    // there was no header at all (legacy auto-fill).
    request.request.headers[headerKey.toLowerCase()] = tenant.id
    // We already loaded this tenant by domain; prime the by-id resolution cache
    // (when enabled) so the downstream guard's by-id lookup is a hit instead of
    // a second backoffice round-trip for the same tenant.
    await primeResolvedTenant(tenant)
    return next()
  }
}
