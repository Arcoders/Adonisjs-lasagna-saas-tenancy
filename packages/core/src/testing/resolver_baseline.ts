import TenantResolverRegistry from '../services/resolvers/registry.js'

/**
 * Integration-isolation baseline for the tenant resolver chain.
 *
 * The integration suite boots one app, so the `TenantResolverRegistry` is a
 * shared container singleton. A spec that re-boots the provider with a different
 * `resolverStrategy` mutates the registry chain in place (via `setChain`); if it
 * does not restore the chain, every later spec that resolves a tenant from the
 * `x-tenant-id` header gets the wrong resolver and fails closed with a 400. The
 * config-baseline guard cannot catch this: the config object is restored, but the
 * registry is a separate singleton derived from it at boot.
 *
 * This returns a {@link https://npmjs.com/package/@adonisjs-lasagna/satellite-test-kit Baseline}-shaped
 * object (structurally; core does not depend on the kit) so the kit's isolation
 * backstop snapshots the boot chain and restores it after any group that left it
 * drifted. It is exposed on the unstable `/internal` subpath and consumed only by
 * the test harness, never by host apps.
 *
 * Restore is `setChain` only. The registry is mutated in place, so the same
 * singleton instance the request path caches already reflects the restored chain;
 * resetting the module-level resolution caches is unnecessary (and would couple
 * this boot-safe module to the boot-heavy request extension). Imports only the
 * plain registry class, so it is safe in the no-build / pre-boot loops that pull
 * in `/internal`.
 */
export interface ResolverStateBaseline {
  name: string
  capture: () => readonly string[]
  equals: (a: readonly string[], b: readonly string[]) => boolean
  restore: (baseline: readonly string[]) => void
}

interface AppLike {
  container: { make<T>(constructor: new () => T): Promise<T> }
}

export async function createResolverStateBaseline(app: AppLike): Promise<ResolverStateBaseline> {
  const registry = await app.container.make(TenantResolverRegistry)
  return {
    name: 'tenant resolver chain',
    capture: () => [...registry.chain()],
    equals: (a, b) => a.length === b.length && a.every((name, index) => name === b[index]),
    restore: (baseline) => {
      registry.setChain([...baseline])
    },
  }
}
