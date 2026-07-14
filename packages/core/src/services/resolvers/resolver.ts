import type { HttpRequest } from '@adonisjs/core/http'
import { isUuidV4 } from '../isolation/identifier.js'

/**
 * The tenant-resolver contract version: the shape of {@link TenantResolver}. A
 * custom resolver declares the version it was built against via
 * `contractVersion`; {@link TenantResolverRegistry} compares it to this constant
 * so a resolver compiled for a newer core fails loudly at registration. Bump as
 * a MAJOR for a backward-incompatible change. INDEPENDENT of the satellite ABI
 * and the published version.
 *
 * v2 (current): added the optional {@link TenantResolver.trust} classification
 * (drives the resolution-safety audit) and the optional
 * {@link TenantResolver.resolveSync} synchronous entry point (the routing chain
 * requires it; see {@link TenantResolverRegistry.setChain}). Both are optional,
 * so a v1 resolver still registers; a v1 resolver placed in the routing chain
 * without `resolveSync`, however, now fails closed at `setChain`.
 */
export const RESOLVER_CONTRACT_VERSION = 2

/**
 * Where a resolver takes the tenant identifier FROM, which is what makes it more
 * or less spoofable. The resolution-safety audit keys on it:
 *
 *   - `'host'`: from the request host (a subdomain or a custom domain). Spoofable
 *     via `X-Forwarded-Host` under a permissive proxy trust unless
 *     `resolver.expectedHostSuffix` bounds the accepted hosts.
 *   - `'client'`: from attacker-controllable request data (a header, a URL path
 *     segment, a query/body field). A swapped id is a cross-tenant IDOR unless an
 *     `authorizeTenantAccess` membership gate rejects the principal.
 *   - `'server'`: derived server-side from something the caller cannot forge (a
 *     verified session, a server-side lookup). Not directly attacker-controlled.
 *
 * FAIL-SAFE default: when a resolver omits `trust`, the audit treats it as
 * `'client'` (the riskiest class), so a custom resolver with no declared trust
 * still trips the IDOR membership-gate nudge/hard-fail. Opt out only by wiring
 * `authorizeTenantAccess`, setting `acknowledgeNoMembershipGate`, or declaring
 * `trust: 'server'` explicitly.
 */
export type ResolverTrust = 'host' | 'client' | 'server'

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
 * `resolve` may return a Promise (so a resolver can hit a cache or a remote
 * service), but a resolver that lives in the routing chain MUST also expose a
 * synchronous {@link TenantResolver.resolveSync}: the routing/attribution path
 * cannot await. See {@link SyncTenantResolver} for a base that implements both
 * from one synchronous method.
 */
export interface TenantResolver {
  readonly name: string
  /**
   * Contract version this resolver was built against (see
   * {@link RESOLVER_CONTRACT_VERSION}). Omitted on legacy resolvers. The
   * registry warns rather than fails when it is absent.
   */
  readonly contractVersion?: number
  /**
   * Trust classification (see {@link ResolverTrust}). Optional; when omitted the
   * resolution-safety audit treats the resolver as `'client'` (fail-safe).
   */
  readonly trust?: ResolverTrust
  resolve(request: HttpRequest): TenantResolveResult | Promise<TenantResolveResult>
  /**
   * Synchronous resolution for the routing/attribution path (the `TenantAdapter`,
   * rate-limit, and metrics all resolve without awaiting). A resolver that can
   * decide synchronously implements this, and {@link TenantResolverRegistry.resolveSync}
   * calls it directly, with no Promise sniffing. A resolver WITHOUT `resolveSync` is
   * async-only and cannot participate in synchronous routing; placing it in the
   * chain fails closed at {@link TenantResolverRegistry.setChain} (else
   * `request.tenant()` would resolve a tenant the sync path never sees, which is a
   * split-brain).
   */
  resolveSync?(request: HttpRequest): TenantResolveResult
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
    // A UUID is case-insensitive, so `ABC…` and `abc…` name the SAME tenant.
    // Canonicalize to lowercase here, at the one place every resolver mints an
    // id hit, so a mixed-case identifier collapses onto ONE resolution-cache
    // entry, ONE rate-limit bucket, and ONE metrics row instead of forging a
    // parallel set. Gated on `isUuidV4` so an opaque non-UUID id from a custom
    // resolver (which may be case-significant) passes through untouched.
    return { type: 'id', tenantId: isUuidV4(tenantId) ? tenantId.toLowerCase() : tenantId }
  },
  domain(domain: string): TenantHit {
    return { type: 'domain', domain }
  },
  miss(): undefined {
    return undefined
  },
}

/**
 * Base for a purely SYNCHRONOUS tenant resolver: implement the single
 * {@link SyncTenantResolver.resolveSync} method plus `name` and `trust`, and the
 * base supplies both the current `contractVersion` and an async-compatible
 * `resolve` that just forwards to `resolveSync`. This is what every built-in
 * extends, and the recommended base for a host's own synchronous resolver, so a
 * routing-chain resolver satisfies the `resolveSync` requirement by construction.
 */
export abstract class SyncTenantResolver implements TenantResolver {
  abstract readonly name: string
  abstract readonly trust: ResolverTrust
  readonly contractVersion: number = RESOLVER_CONTRACT_VERSION
  abstract resolveSync(request: HttpRequest): TenantResolveResult
  resolve(request: HttpRequest): TenantResolveResult {
    return this.resolveSync(request)
  }
}
