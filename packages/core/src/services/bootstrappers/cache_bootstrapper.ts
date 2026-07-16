import type { BootstrapperContext, TenantBootstrapper } from '../bootstrapper_registry.js'
import { getCache } from '../../utils/cache.js'
import { tenancy } from '../../tenancy.js'
import { assertSafeIdentifier } from '../../isthmus/guarded_identifier.js'

type CacheNamespace = ReturnType<ReturnType<typeof getCache>['namespace']>
type NamespaceFactory = (namespace: string) => CacheNamespace

/**
 * The fixed string prefix prepended to a tenant's id to form its cache
 * namespace key. Every per-tenant Redis entry is stored under `tenant_<id>`,
 * which keeps one tenant's cached values isolated from another's within the
 * active scope. Used by the cache bootstrapper's `enter` step and by
 * `tenantCache()` when deriving the namespace for the current `tenancy.run()`.
 */
export const CACHE_NAMESPACE_PREFIX = 'tenant_'

let namespaceFactory: NamespaceFactory = (name) => getCache().namespace(name)

/**
 * Test-only: swap the namespace factory so unit tests can avoid opening a
 * real Redis connection. Pass `undefined` to restore the default.
 */
export function __setNamespaceFactoryForTests(factory: NamespaceFactory | undefined): void {
  namespaceFactory = factory ?? ((name) => getCache().namespace(name))
}

/**
 * Build a `TenantBootstrapper` that prepares a per-tenant cache namespace
 * for the active `tenancy.run()` scope. Custom factories can be passed for
 * testing; production code should use the default exported singleton.
 *
 * The bootstrapper's `enter` materializes the namespace eagerly (so any
 * factory failure surfaces at scope entry, not on first `tenantCache()`
 * call). The handle itself is re-derived on demand via `tenancy.currentId()`,
 * so namespaces never leak between scopes.
 */
export function createCacheBootstrapper(factory?: NamespaceFactory): TenantBootstrapper {
  const f = factory ?? namespaceFactory
  return {
    name: 'cache',
    enter(ctx: BootstrapperContext) {
      // Validate now so a malformed id never lands in a cache namespace
      // (the namespace `tenant_<id>` keys every Redis entry for the scope;
      // an injected separator could let one tenant read another's cache).
      assertSafeIdentifier(ctx.tenant.id, 'tenant id')
      // Materialize once so a broken factory throws at the boundary, not
      // deep in user code. The handle is discarded. `tenantCache()` will
      // re-derive when callers ask for it.
      f(`${CACHE_NAMESPACE_PREFIX}${ctx.tenant.id}`)
    },
  }
}

/**
 * Default `TenantBootstrapper` singleton named `cache` that prepares a
 * per-tenant cache namespace whenever a `tenancy.run()` scope is entered. Its
 * `enter` hook validates the tenant id with `assertSafeIdentifier` and then
 * eagerly materializes the `tenant_<id>` namespace through the configured
 * factory, so a malformed id or a broken factory fails at scope entry rather
 * than later inside user code. The namespace handle itself is re-derived on
 * demand by `tenantCache()`, keeping cache entries isolated between tenants.
 */
const cacheBootstrapper = createCacheBootstrapper()

export default cacheBootstrapper

/**
 * Returns the cache namespace bound to the active `tenancy.run()` scope.
 * Throws outside a scope; use `getCache()` directly for non-tenant access.
 */
export function tenantCache(): CacheNamespace {
  const id = tenancy.currentId()
  if (!id) {
    throw new Error(
      'tenantCache() called outside a tenancy.run() scope. Wrap your code in tenancy.run(tenant, fn) or use getCache() for non-tenant cache access.'
    )
  }
  // Defense-in-depth: `tenantCache()` can be called directly (e.g. inside a
  // custom hook) after the scope is established, so validate here too. It's the
  // same guard the other bootstrapper helpers (drive/mail/session/transmit) apply.
  assertSafeIdentifier(id, 'tenant id')
  return namespaceFactory(`${CACHE_NAMESPACE_PREFIX}${id}`)
}
