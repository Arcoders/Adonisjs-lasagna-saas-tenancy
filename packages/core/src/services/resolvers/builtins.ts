import type { HttpRequest } from '@adonisjs/core/http'
import { getConfig } from '../../config.js'
import { isProductionNodeEnv } from '../../utils/env.js'
import InvalidTenantIdentifierException from '../../exceptions/invalid_tenant_identifier_exception.js'
import { isUuidV4 } from '../isolation/identifier.js'
import {
  RESOLVER_CONTRACT_VERSION,
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
  return raw.split(':')[0]!
}

/** Normalize the `expectedHostSuffix` config into a clean list (leading dot stripped). */
export function expectedHostSuffixes(): string[] {
  const raw = getConfig().resolver?.expectedHostSuffix
  if (!raw) return []
  return (Array.isArray(raw) ? raw : [raw])
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .map((s) => (s.startsWith('.') ? s.slice(1) : s).toLowerCase())
}

/**
 * Is `host` allowed by the configured suffix allowlist? An empty allowlist
 * (the default) allows everything. The boot check warns about that posture
 * separately. A host matches a suffix when it equals it or is a sub-host of it
 * (`app.com` matches `app.com` and `a.app.com`, never `app.com.evil.io`).
 */
export function hostMatchesExpectedSuffix(host: string): boolean {
  const suffixes = expectedHostSuffixes()
  if (suffixes.length === 0) return true
  const h = host.toLowerCase()
  return suffixes.some((suf) => h === suf || h.endsWith(`.${suf}`))
}

/**
 * Tenant resolver that reads the tenant identifier from a configured request
 * header whose key comes from `getConfig().tenantHeaderKey` (default
 * `x-tenant-id`). It implements the `TenantResolver` contract with a `header`
 * name and the current contract version, returning a `ResolverHit.id` when the
 * header is present and a `ResolverHit.miss` otherwise. This is the strategy
 * most server-to-server traffic relies on.
 */
export class HeaderResolver implements TenantResolver {
  readonly name = 'header'
  readonly contractVersion = RESOLVER_CONTRACT_VERSION
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
  readonly contractVersion = RESOLVER_CONTRACT_VERSION
  resolve(request: HttpRequest): TenantResolveResult {
    const { baseDomain } = getConfig()
    const host = hostnameOf(request)
    if (!host) return ResolverHit.miss()
    // Reject a host outside the configured allowlist BEFORE extracting a label,
    // so a spoofed X-Forwarded-Host cannot pick a tenant from an unexpected host.
    if (!hostMatchesExpectedSuffix(host)) return ResolverHit.miss()
    if (host === baseDomain) return ResolverHit.miss()

    const suffix = baseDomain.startsWith('.') ? baseDomain : `.${baseDomain}`
    if (host.endsWith(suffix)) {
      const sub = host.slice(0, host.length - suffix.length)
      return sub ? ResolverHit.id(sub) : ResolverHit.miss()
    }
    // Host doesn't end with baseDomain. In dev we fall back to the leftmost
    // label so `127.0.0.1.nip.io`-style hosts still resolve. In PRODUCTION we
    // refuse: accepting an arbitrary off-baseDomain host would let any host
    // routed to the app pick a tenant from its leftmost label, diluting the
    // "host must be under baseDomain" invariant. (Downstream UUID validation
    // already blocks non-UUID labels, but don't rely on that alone.)
    if (isProductionNodeEnv()) return ResolverHit.miss()
    const labels = host.split('.')
    return labels.length > 1 ? ResolverHit.id(labels[0]!) : ResolverHit.miss()
  }
}

/**
 * Pulls the tenant id from the first segment of the URL path
 * (`/<tenantId>/foo` maps to `tenantId`). `ignorePaths` from config let apps
 * exclude prefixes like `/health` or `/admin`.
 */
export class PathResolver implements TenantResolver {
  readonly name = 'path'
  readonly contractVersion = RESOLVER_CONTRACT_VERSION
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
 * This is the typical "either acme.app.com or acme.com" SaaS deployment.
 * Host matches before subdomain math because custom domains are the
 * stronger signal.
 */
export class DomainOrSubdomainResolver implements TenantResolver {
  readonly name = 'domain-or-subdomain'
  readonly contractVersion = RESOLVER_CONTRACT_VERSION
  resolve(request: HttpRequest): TenantResolveResult {
    const { baseDomain } = getConfig()
    const host = hostnameOf(request)
    if (!host) return ResolverHit.miss()
    // A host outside the allowlist is refused before either the subdomain math
    // OR the custom-domain `findByDomain` lookup, closing the spoofed-host hop
    // for both branches in one place.
    if (!hostMatchesExpectedSuffix(host)) return ResolverHit.miss()

    const suffix = baseDomain.startsWith('.') ? baseDomain : `.${baseDomain}`
    if (host !== baseDomain && host.endsWith(suffix)) {
      const sub = host.slice(0, host.length - suffix.length)
      if (sub) return ResolverHit.id(sub)
    }
    // Not a subdomain of baseDomain, so it must be a custom domain. Defer
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
  readonly contractVersion = RESOLVER_CONTRACT_VERSION
  resolve(request: HttpRequest): TenantResolveResult {
    const cfg = getConfig().requestData ?? {}
    const queryKey = cfg.queryKey ?? 'tenant_id'
    const bodyKey = cfg.bodyKey ?? 'tenant_id'
    const order = cfg.sourceOrder ?? ['query', 'body']

    for (const source of order) {
      const raw = source === 'query' ? request.qs()?.[queryKey] : request.input(bodyKey)
      if (raw === undefined || raw === null) continue

      // Present but not a string (e.g. `?tenant_id[]=a&tenant_id[]=b` arrives as
      // an array, a nested object, a number): fail closed with a 400 rather than
      // coercing a type-confusion attempt into a tenant id or silently missing.
      if (typeof raw !== 'string') throw new InvalidTenantIdentifierException()

      if (raw.length === 0) continue
      // Only a well-formed tenant id is a hit; a present-but-malformed string
      // falls through so a later resolver in the chain can still match (and, if
      // none does, the guard's own UUID check rejects it).
      if (isUuidV4(raw)) return ResolverHit.id(raw)
    }

    return ResolverHit.miss()
  }
}

/**
 * A frozen, read-only array holding one instance of every built-in tenant
 * resolver: the header, subdomain, path, domain-or-subdomain, and request-data
 * strategies. The provider seeds these into the resolver registry at boot so the
 * async resolver chain can try each strategy in order until one returns a hit.
 */
export const builtInResolvers: readonly TenantResolver[] = Object.freeze([
  new HeaderResolver(),
  new SubdomainResolver(),
  new PathResolver(),
  new DomainOrSubdomainResolver(),
  new RequestDataResolver(),
])
