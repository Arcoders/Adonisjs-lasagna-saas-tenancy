import type {
  BootstrapperContext,
  TenantBootstrapper,
} from '../bootstrapper_registry.js'
import { getCache } from '../../utils/cache.js'
import { tenancy } from '../../tenancy.js'

type CacheNamespace = ReturnType<ReturnType<typeof getCache>['namespace']>
type NamespaceFactory = (namespace: string) => CacheNamespace

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
export function createCacheBootstrapper(
  factory?: NamespaceFactory
): TenantBootstrapper {
  const f = factory ?? namespaceFactory
  return {
    name: 'cache',
    enter(ctx: BootstrapperContext) {
      // Materialize once so a broken factory throws at the boundary, not
      // deep in user code. The handle is discarded — `tenantCache()` will
      // re-derive when callers ask for it.
      f(`${CACHE_NAMESPACE_PREFIX}${ctx.tenant.id}`)
    },
  }
}

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
  return namespaceFactory(`${CACHE_NAMESPACE_PREFIX}${id}`)
}
