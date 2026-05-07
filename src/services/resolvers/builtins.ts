import type { HttpRequest } from '@adonisjs/core/http'
import { getConfig } from '../../config.js'
import {
  ResolverHit,
  type TenantResolveResult,
  type TenantResolver,
} from './resolver.js'

/**
 * Strip the port from a `Host` header value so subdomain math works
 * regardless of whether the dev server runs on `localhost:3333`.
 */
function hostnameOf(request: HttpRequest): string {
  const raw = request.hostname() ?? ''
  return raw.split(':')[0]
}

/**
 * Reads the tenant id from a configured request header (default
 * `x-tenant-id`). Most server-to-server traffic uses this.
 */
export class HeaderResolver implements TenantResolver {
  readonly name = 'header'
  resolve(request: HttpRequest): TenantResolveResult {
    const key = getConfig().tenantHeaderKey
    const value = request.header(key)
    return value ? ResolverHit.id(value) : ResolverHit.miss()
  }
}

/**
 * Pulls the tenant id from the leftmost subdomain of the request host,
 * stripped of `baseDomain`. Returns `undefined` for the bare base domain
 * itself (so apex hits can be routed to a marketing site / central app
 * without trying to resolve a tenant).
 */
export class SubdomainResolver implements TenantResolver {
  readonly name = 'subdomain'
  resolve(request: HttpRequest): TenantResolveResult {
    const { baseDomain } = getConfig()
    const host = hostnameOf(request)
    if (!host) return ResolverHit.miss()
    if (host === baseDomain) return ResolverHit.miss()

    const suffix = baseDomain.startsWith('.') ? baseDomain : `.${baseDomain}`
    if (host.endsWith(suffix)) {
      const sub = host.slice(0, host.length - suffix.length)
      return sub ? ResolverHit.id(sub) : ResolverHit.miss()
    }
    // Host doesn't end with baseDomain — fall back to the leftmost label
    // so dev environments using `127.0.0.1.nip.io`-style hosts still work.
    const labels = host.split('.')
    return labels.length > 1 ? ResolverHit.id(labels[0]) : ResolverHit.miss()
  }
}

/**
 * Pulls the tenant id from the first segment of the URL path
 * (`/<tenantId>/foo` → `tenantId`). `ignorePaths` from config let apps
 * exclude prefixes like `/health` or `/admin`.
 */
export class PathResolver implements TenantResolver {
  readonly name = 'path'
  resolve(request: HttpRequest): TenantResolveResult {
    const { ignorePaths } = getConfig()
    const url = request.url(false)
    if (ignorePaths?.some((p) => url.startsWith(p))) return ResolverHit.miss()
    const segment = url.split('/').find(Boolean)
    return segment ? ResolverHit.id(segment) : ResolverHit.miss()
  }
}

/**
 * Combined strategy: try to match the request host as an exact
 * `customDomain` first (returns a `{ domain }` envelope so the registry
 * asks the repository for the tenant by domain); if the host is a
 * subdomain of `baseDomain`, fall back to subdomain extraction.
 *
 * This is the typical "either acme.app.com or acme.com" SaaS deployment
 * — host matches before subdomain math because custom domains are the
 * stronger signal.
 */
export class DomainOrSubdomainResolver implements TenantResolver {
  readonly name = 'domain-or-subdomain'
  resolve(request: HttpRequest): TenantResolveResult {
    const { baseDomain } = getConfig()
    const host = hostnameOf(request)
    if (!host) return ResolverHit.miss()

    const suffix = baseDomain.startsWith('.') ? baseDomain : `.${baseDomain}`
    if (host !== baseDomain && host.endsWith(suffix)) {
      const sub = host.slice(0, host.length - suffix.length)
      if (sub) return ResolverHit.id(sub)
    }
    // Not a subdomain of baseDomain → must be a custom domain. Defer
    // resolution to the repository (`findByDomain`) via the registry.
    if (host !== baseDomain) {
      return ResolverHit.domain(host)
    }
    return ResolverHit.miss()
  }
}

/**
 * Pulls the tenant id from a query-string parameter or a request-body
 * field. The config field `requestData` controls which key to read from
 * each source; both default to `tenant_id`.
 */
export class RequestDataResolver implements TenantResolver {
  readonly name = 'request-data'
  resolve(request: HttpRequest): TenantResolveResult {
    const cfg = getConfig().requestData ?? {}
    const queryKey = cfg.queryKey ?? 'tenant_id'
    const bodyKey = cfg.bodyKey ?? 'tenant_id'

    const fromQuery = request.qs()?.[queryKey]
    if (typeof fromQuery === 'string' && fromQuery.length > 0) {
      return ResolverHit.id(fromQuery)
    }

    // request.input(...) covers JSON, form-encoded, multipart bodies.
    const fromBody = (request as any).input?.(bodyKey)
    if (typeof fromBody === 'string' && fromBody.length > 0) {
      return ResolverHit.id(fromBody)
    }

    return ResolverHit.miss()
  }
}

export const builtInResolvers: readonly TenantResolver[] = Object.freeze([
  new HeaderResolver(),
  new SubdomainResolver(),
  new PathResolver(),
  new DomainOrSubdomainResolver(),
  new RequestDataResolver(),
])
