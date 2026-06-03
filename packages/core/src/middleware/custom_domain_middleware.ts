import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract } from '../types/contracts.js'
import TenantHeaderDomainMismatchException from '../exceptions/tenant_header_domain_mismatch_exception.js'
import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

export interface CustomDomainOptions {
  /**
   * When `strict` is true and both a `Host` matching a custom domain AND
   * an `x-tenant-id` header are present, the request is REJECTED with
   * 400 unless they agree. Without this, a header value can override
   * the domain — a tenant-hop vector if your CDN/edge fixes Host but
   * passes through arbitrary headers.
   *
   * Default `false` for backwards compatibility. Multi-tenant SaaS
   * deployments should set this to `true` in their kernel.
   */
  strict?: boolean
}

export default class CustomDomainMiddleware {
  async handle({ request }: HttpContext, next: NextFn, options: CustomDomainOptions = {}) {
    const host = request.header('host')?.split(':')[0]
    const headerTenantId = request.header('x-tenant-id')

    if (!host) return next()

    if (headerTenantId && !options.strict) {
      // Legacy behavior: an explicit header wins, even if it disagrees
      // with the Host. Document and skip.
      return next()
    }

    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
    const tenant = await repo.findByDomain(host)

    if (!tenant) {
      // No tenant claims this Host. If the caller also sent a header,
      // we let it through unchanged — that's how header-based routing
      // works for hosts the package doesn't manage. In strict mode this
      // is still acceptable: a request without a domain claim cannot
      // mismatch a domain.
      return next()
    }

    if (headerTenantId && options.strict && headerTenantId !== tenant.id) {
      // Both signals are present and they disagree. Reject — the safer
      // failure mode is "no service" rather than "service for whichever
      // side the attacker controls".
      throw new TenantHeaderDomainMismatchException()
    }

    // Either the header agrees with the domain (strict pass-through), or
    // there was no header at all (legacy auto-fill).
    request.request.headers['x-tenant-id'] = tenant.id
    return next()
  }
}
