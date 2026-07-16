import type { HttpRequest } from '@adonisjs/core/http'
import ExtensionRegistry from '../extension_registry.js'
import {
  RESOLVER_CONTRACT_VERSION,
  type TenantResolver,
  type TenantResolveResult,
} from './resolver.js'

/**
 * Holds every registered `TenantResolver` plus the strategy chain to
 * apply at resolve time. The chain is a list of resolver names in
 * order; the first one that returns a non-undefined result wins.
 *
 * The provider seeds built-ins (`header`, `subdomain`, `path`,
 * `domain-or-subdomain`, `request-data`) and selects a single one
 * based on `config.resolverStrategy`. Apps can register their own
 * resolvers via `register(resolver)` and either pick them via config
 * (`resolverStrategy: 'my-resolver'`) or chain several together via
 * `setChain(['domain-or-subdomain', 'header'])`, handy when most
 * traffic arrives by domain but a fallback header is honored for
 * internal API clients.
 */
export default class TenantResolverRegistry extends ExtensionRegistry<string, TenantResolver> {
  #chain: string[] = []

  protected readonly surfaceLabel = 'tenant resolver'
  protected override readonly collisionHint = ' Pass { override: true } to replace it.'

  protected override get surfaceContractVersion(): number {
    return RESOLVER_CONTRACT_VERSION
  }

  /**
   * Every resolver must implement the async entry point `resolve(request)`, which the
   * chain walk and `request.tenant()` both call. A resolver missing it registers fine
   * and then crashes the first time the async path walks the chain; gate it at boot
   * (EXT-2), unconditional, so the omission fails loudly at registration. `resolveSync`
   * stays optional here (async-only resolvers are legitimate off the routing chain);
   * `setChain` is where a chained resolver's `resolveSync` requirement is enforced.
   */
  protected override assertShape(resolver: TenantResolver): void {
    if (typeof resolver.resolve !== 'function') {
      throw new Error(
        `TenantResolverRegistry: resolver "${resolver.name}" does not implement resolve(request) ` +
          `(required by resolver contract v${RESOLVER_CONTRACT_VERSION}). Implement resolve(request) ` +
          `(extend SyncTenantResolver for a purely synchronous resolver, which supplies it).`
      )
    }
  }

  register(resolver: TenantResolver, opts: { override?: boolean } = {}): this {
    const name = this.assertRegistrable(resolver, opts)
    this.entries.set(name, resolver)
    return this
  }

  list(): readonly string[] {
    return [...this.entries.keys()]
  }

  /**
   * Replace the resolver chain. Each entry must be a registered resolver name,
   * AND each resolver must expose `resolveSync` (be synchronous-capable). Both
   * fail closed at boot rather than silently picking the wrong tenant in
   * production:
   *   - an unknown name is a config typo;
   *   - an async-only resolver (no `resolveSync`) cannot serve the synchronous
   *     routing/attribution path, so the sync path would skip it and resolve a
   *     different tenant than the async `request.tenant()`, a split-brain. We
   *     refuse it here, naming the offender, instead of shipping that divergence.
   */
  setChain(names: string[]): this {
    for (const name of names) {
      const resolver = this.entries.get(name)
      if (!resolver) {
        throw new Error(
          `TenantResolverRegistry: cannot put unknown resolver "${name}" in the chain. ` +
            `Registered: ${[...this.entries.keys()].join(', ') || '(none)'}`
        )
      }
      if (typeof resolver.resolveSync !== 'function') {
        throw new Error(
          `TenantResolverRegistry: resolver "${name}" is async-only (no resolveSync) and ` +
            `cannot be placed in the routing chain. The synchronous routing/attribution path ` +
            `(model routing, rate-limit, metrics) would skip it and resolve a different tenant ` +
            `than request.tenant() — a split-brain. Implement resolveSync(request) (extend ` +
            `SyncTenantResolver for a purely synchronous resolver) or remove it from the chain.`
        )
      }
    }
    this.#chain = [...names]
    return this
  }

  chain(): readonly string[] {
    return [...this.#chain]
  }

  override clear(): this {
    super.clear()
    this.#chain = []
    return this
  }

  /**
   * Walk the chain until a resolver returns a hit. Returns the first
   * non-undefined result, or `undefined` when no resolver matched.
   */
  async resolve(request: HttpRequest): Promise<TenantResolveResult> {
    for (const name of this.#chain) {
      const resolver = this.entries.get(name)
      if (!resolver) continue
      const result = await resolver.resolve(request)
      if (result !== undefined) return result
    }
    return undefined
  }

  /**
   * Synchronous chain walk for code paths that cannot await, notably
   * `TenantAdapter`, rate-limit, and metrics. Calls each resolver's explicit
   * `resolveSync` (no Promise sniffing) and the first non-undefined hit wins.
   * A resolver without `resolveSync` is async-only and is skipped here (never
   * called nor awaited). For a config-wired chain this branch is unreachable:
   * `setChain` refuses to admit an async-only resolver, so the sync path and the
   * async `resolve()` agree on the tenant. The skip is the backstop for the one
   * remaining way in: a post-boot `register(name, { override: true })` that
   * swaps a chained resolver for an async-only one without re-running setChain.
   */
  resolveSync(request: HttpRequest): TenantResolveResult {
    for (const name of this.#chain) {
      const resolver = this.entries.get(name)
      if (typeof resolver?.resolveSync !== 'function') continue
      const result = resolver.resolveSync(request)
      if (result !== undefined) return result
    }
    return undefined
  }
}
