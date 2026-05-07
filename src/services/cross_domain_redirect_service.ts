import { getConfig } from '../config.js'
import type { TenantModelContract } from '../types/contracts.js'
import type { HttpRequest } from '@adonisjs/core/http'

export interface BuildUrlOptions {
  /**
   * Preserve query string from the source request when called via
   * `fromRequest()`. Default: false.
   */
  preserveQuery?: boolean
  /**
   * Override the protocol (http / https). Defaults to the request's protocol
   * when going through `fromRequest()`, otherwise `https`.
   */
  protocol?: 'http' | 'https'
  /**
   * Force a port suffix (e.g. `3333`). Defaults to no explicit port (relies
   * on the protocol's default).
   */
  port?: number
}

/**
 * Build absolute URLs that bridge the central domain and tenant subdomains
 * (or custom domains). The hostname strategy is read from
 * `MultitenancyConfig.baseDomain`; when a tenant has a `customDomain`, that
 * takes precedence over the subdomain form.
 *
 * This service does NOT perform redirects itself — it constructs the URL
 * string, leaving the call site to use `response.redirect(url)` or whatever
 * mechanism is appropriate.
 */
export default class CrossDomainRedirectService {
  /** Build a URL that lands the user on the given tenant's host. */
  toTenant(
    tenant: TenantModelContract,
    path: string,
    opts: BuildUrlOptions = {}
  ): string {
    const host = tenant.customDomain ?? this.toTenantSubdomainHost(tenant.id)
    return this.#assemble(host, path, opts)
  }

  /** Build a URL on the central (apex / non-tenant) host. */
  toCentral(path: string, opts: BuildUrlOptions = {}): string {
    return this.#assemble(this.#baseDomain(), path, opts)
  }

  /**
   * Build a URL on a tenant subdomain when only the slug/id is available,
   * without loading the model. Useful in signup flows where the tenant has
   * just been created and you only have the id / slug to hand.
   */
  toTenantSubdomain(slug: string, path: string, opts: BuildUrlOptions = {}): string {
    return this.#assemble(this.toTenantSubdomainHost(slug), path, opts)
  }

  /**
   * Convenience: redirect-style URL builder that mirrors the protocol/port
   * of the current request. Pass `preserveQuery: true` to forward the
   * source request's query string onto the destination path.
   */
  fromRequest(
    request: HttpRequest,
    target: { tenant: TenantModelContract; path: string } | { central: true; path: string },
    opts: BuildUrlOptions = {}
  ): string {
    const protocol = (opts.protocol ?? request.protocol()) as 'http' | 'https'
    const merged: BuildUrlOptions = { ...opts, protocol }
    let path = 'tenant' in target ? target.path : target.path
    if (opts.preserveQuery) {
      const qs = request.parsedUrl?.query
      if (qs && typeof qs === 'string' && qs.length > 0) {
        path = path.includes('?') ? `${path}&${qs}` : `${path}?${qs}`
      }
    }
    if ('central' in target) return this.toCentral(path, merged)
    return this.toTenant(target.tenant, path, merged)
  }

  /** Hostname for a tenant's subdomain on the configured base domain. */
  toTenantSubdomainHost(slug: string): string {
    assertSafeHostLabel(slug, 'tenant slug')
    const base = this.#baseDomain()
    return `${slug}.${base}`
  }

  #baseDomain(): string {
    const cfg = getConfig()
    return cfg.baseDomain
  }

  #assemble(host: string, path: string, opts: BuildUrlOptions): string {
    assertSafeHost(host)
    const protocol = opts.protocol === 'http' ? 'http' : 'https'
    const portSuffix = opts.port ? `:${assertSafePort(opts.port)}` : ''
    const normalizedPath = normalizeRedirectPath(path)
    return `${protocol}://${host}${portSuffix}${normalizedPath}`
  }
}

/**
 * RFC-1123-ish hostname validator. Accepts only ASCII letters, digits,
 * dots, and dashes; rejects anything that could allow URL parser tricks
 * (`@`, `#`, `/`, `\`, `?`, ` `, control chars, embedded credentials).
 *
 * Why strict: `tenant.customDomain` and `slug` are interpolated directly
 * into a Location header. Without this guard, a value like
 * `evil.com#@trusted.com` or one containing CR/LF would let an attacker
 * who controls those fields craft an open redirect or smuggle a header.
 * `customDomain` is admin-controlled, but defense-in-depth still applies.
 */
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i
const HOST_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i

function assertSafeHost(host: string): void {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253 || !HOST_RE.test(host)) {
    throw new Error(`Refusing to build URL with unsafe host "${host}".`)
  }
}

function assertSafeHostLabel(label: string, kind: string): void {
  if (typeof label !== 'string' || !HOST_LABEL_RE.test(label)) {
    throw new Error(`Refusing to build URL with unsafe ${kind} "${label}".`)
  }
}

function assertSafePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Refusing to build URL with invalid port "${port}".`)
  }
  return port
}

/**
 * Reject any path containing CR/LF (header smuggling) or starting with `//`
 * (protocol-relative URL → bypasses the explicit host we just validated).
 */
function normalizeRedirectPath(path: string): string {
  if (typeof path !== 'string') {
    throw new Error('Refusing to build URL with non-string path.')
  }
  if (/[\r\n]/.test(path)) {
    throw new Error('Refusing to build URL: path contains CR/LF.')
  }
  const withSlash = path.startsWith('/') ? path : `/${path}`
  if (withSlash.startsWith('//')) {
    throw new Error('Refusing to build URL: protocol-relative path "//..." would bypass host.')
  }
  return withSlash
}
