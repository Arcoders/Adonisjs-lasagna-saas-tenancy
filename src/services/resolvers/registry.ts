import type { HttpRequest } from '@adonisjs/core/http'
import type { TenantResolver, TenantResolveResult } from './resolver.js'

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
 * `setChain(['domain-or-subdomain', 'header'])` — handy when most
 * traffic arrives by domain but a fallback header is honored for
 * internal API clients.
 */
export default class TenantResolverRegistry {
  readonly #resolvers = new Map<string, TenantResolver>()
  #chain: string[] = []

  register(resolver: TenantResolver): this {
    this.#resolvers.set(resolver.name, resolver)
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
   * Replace the resolver chain. Each entry must be a registered resolver
   * name. Throws if any name is unknown so misconfiguration fails at boot
   * instead of silently picking the wrong tenant in production.
   */
  setChain(names: string[]): this {
    for (const name of names) {
      if (!this.#resolvers.has(name)) {
        throw new Error(
          `TenantResolverRegistry: cannot put unknown resolver "${name}" in the chain. ` +
            `Registered: ${[...this.#resolvers.keys()].join(', ') || '(none)'}`
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
}
