import type { HttpRequest } from '@adonisjs/core/http'
import { assertContractCompat } from '../../sdk/contract_version.js'
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
export default class TenantResolverRegistry {
  readonly #resolvers = new Map<string, TenantResolver>()
  #chain: string[] = []

  /** The tenant-resolver contract version this registry enforces. */
  get contractVersion(): number {
    return RESOLVER_CONTRACT_VERSION
  }

  register(resolver: TenantResolver, opts: { override?: boolean } = {}): this {
    const name = resolver?.name
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('TenantResolverRegistry.register: resolver.name must be a non-empty string.')
    }
    // A duplicate name would silently shadow an existing resolver and change how
    // tenants resolve. Refuse unless the caller explicitly overrides.
    if (this.#resolvers.has(name) && opts.override !== true) {
      throw new Error(
        `TenantResolverRegistry: a resolver named "${name}" is already registered. ` +
          `Pass { override: true } to replace it.`
      )
    }
    // A resolver built for a newer core contract would expect a surface this
    // core does not provide: refuse it. An older/unversioned one warns.
    assertContractCompat(
      resolver.contractVersion,
      RESOLVER_CONTRACT_VERSION,
      `tenant resolver "${name}"`
    )
    this.#resolvers.set(name, resolver)
    return this
  }

  unregister(name: string): boolean {
    return this.#resolvers.delete(name)
  }

  has(name: string): boolean {
    return this.#resolvers.has(name)
  }

  list(): readonly string[] {
    return [...this.#resolvers.keys()]
  }

  /**
   * Replace the resolver chain. Each entry must be a registered resolver name,
   * AND each resolver must expose `resolveSync` (be synchronous-capable). Both
   * fail closed at boot rather than silently picking the wrong tenant in
   * production:
   *   - an unknown name is a config typo;
   *   - an async-only resolver (no `resolveSync`) cannot serve the synchronous
   *     routing/attribution path, so the sync path would skip it and resolve a
   *     different tenant than the async `request.tenant()` — a split-brain. We
   *     refuse it here, naming the offender, instead of shipping that divergence.
   */
  setChain(names: string[]): this {
    for (const name of names) {
      const resolver = this.#resolvers.get(name)
      if (!resolver) {
        throw new Error(
          `TenantResolverRegistry: cannot put unknown resolver "${name}" in the chain. ` +
            `Registered: ${[...this.#resolvers.keys()].join(', ') || '(none)'}`
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

  clear(): this {
    this.#resolvers.clear()
    this.#chain = []
    return this
  }

  /**
   * Walk the chain until a resolver returns a hit. Returns the first
   * non-undefined result, or `undefined` when no resolver matched.
   */
  async resolve(request: HttpRequest): Promise<TenantResolveResult> {
    for (const name of this.#chain) {
      const resolver = this.#resolvers.get(name)
      if (!resolver) continue
      const result = await resolver.resolve(request)
      if (result !== undefined) return result
    }
    return undefined
  }

  /**
   * Synchronous chain walk for code paths that cannot await, notably
   * `TenantAdapter`, rate-limit, and metrics. Calls each resolver's explicit
   * `resolveSync` — no Promise sniffing — and the first non-undefined hit wins.
   * A resolver without `resolveSync` is async-only and is skipped here (never
   * called nor awaited). For a config-wired chain this branch is unreachable:
   * `setChain` refuses to admit an async-only resolver, so the sync path and the
   * async `resolve()` agree on the tenant. The skip is the backstop for the one
   * remaining way in — a post-boot `register(name, { override: true })` that
   * swaps a chained resolver for an async-only one without re-running setChain.
   */
  resolveSync(request: HttpRequest): TenantResolveResult {
    for (const name of this.#chain) {
      const resolver = this.#resolvers.get(name)
      if (typeof resolver?.resolveSync !== 'function') continue
      const result = resolver.resolveSync(request)
      if (result !== undefined) return result
    }
    return undefined
  }
}
