import type { HttpRequest } from '@adonisjs/core/http'

/**
 * Strategy contract every tenant resolver implements. A resolver inspects
 * the incoming HTTP request and returns either:
 *
 *   - the **tenant id** as a string (matched canonically),
 *   - a **`{ domain }` envelope** when the resolver pulled a custom
 *     domain or subdomain off the request — the registry then asks the
 *     repository for the tenant by domain,
 *   - `undefined` when this resolver doesn't apply (so the registry can
 *     fall through to the next strategy).
 *
 * The async return is allowed so future resolvers can hit a cache or a
 * remote service without changing the surface.
 */
export interface TenantResolver {
  readonly name: string
  resolve(
    request: HttpRequest
  ): TenantResolveResult | Promise<TenantResolveResult>
}

export type TenantResolveResult =
  | { type: 'id'; tenantId: string }
  | { type: 'domain'; domain: string }
  | undefined

/**
 * Convenience constructors so resolver implementations don't have to
 * spell the discriminated-union shape every time.
 */
export const ResolverHit = {
  id(tenantId: string): TenantResolveResult {
    return { type: 'id', tenantId }
  },
  domain(domain: string): TenantResolveResult {
    return { type: 'domain', domain }
  },
  miss(): TenantResolveResult {
    return undefined
  },
}
