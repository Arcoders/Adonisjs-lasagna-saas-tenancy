import type { HttpRequest } from '@adonisjs/core/http'

/**
 * The tenant-resolver contract version: the shape of {@link TenantResolver}. A
 * custom resolver declares the version it was built against via
 * `contractVersion`; {@link TenantResolverRegistry} compares it to this constant
 * so a resolver compiled for a newer core fails loudly at registration. Bump as
 * a MAJOR for a backward-incompatible change. INDEPENDENT of the satellite ABI
 * and the published version.
 */
export const RESOLVER_CONTRACT_VERSION = 1

/**
 * Strategy contract every tenant resolver implements. A resolver inspects
 * the incoming HTTP request and returns either:
 *
 *   - the **tenant id** as a string (matched canonically),
 *   - a **`{ domain }` envelope** when the resolver pulled a custom
 *     domain or subdomain off the request, so the registry then asks the
 *     repository for the tenant by domain,
 *   - `undefined` when this resolver doesn't apply (so the registry can
 *     fall through to the next strategy).
 *
 * The async return is allowed so future resolvers can hit a cache or a
 * remote service without changing the surface.
 */
export interface TenantResolver {
  readonly name: string
  /**
   * Contract version this resolver was built against (see
   * {@link RESOLVER_CONTRACT_VERSION}). Omitted on legacy resolvers. The
   * registry warns rather than fails when it is absent.
   */
  readonly contractVersion?: number
  resolve(request: HttpRequest): TenantResolveResult | Promise<TenantResolveResult>
}

/**
 * A positive resolution: either a tenant id or a `{ domain }` envelope. Absence
 * (a resolver that doesn't apply) is modelled separately as `undefined` in
 * {@link TenantResolveResult}, so the constructors below return a concrete hit
 * and only `miss()` is `undefined`.
 */
export type TenantHit = { type: 'id'; tenantId: string } | { type: 'domain'; domain: string }

/**
 * The outcome returned by a {@link TenantResolver}'s `resolve()` call against an
 * incoming HTTP request. It is either a positive {@link TenantHit} (a tenant id
 * or a `{ domain }` envelope) or `undefined` when the resolver does not apply,
 * letting the registry fall through to the next strategy in the chain.
 */
export type TenantResolveResult = TenantHit | undefined

/**
 * Convenience factory helpers that build the discriminated-union result a
 * tenant resolver returns, so implementations never spell the shape by hand.
 * Exposes `id(tenantId)` for a matched tenant id, `domain(domain)` for a
 * custom-domain envelope the registry resolves via the repository, and
 * `miss()` returning `undefined` when the resolver does not apply.
 */
export const ResolverHit = {
  id(tenantId: string): TenantHit {
    return { type: 'id', tenantId }
  },
  domain(domain: string): TenantHit {
    return { type: 'domain', domain }
  },
  miss(): undefined {
    return undefined
  },
}
