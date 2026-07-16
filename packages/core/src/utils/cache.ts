import { BentoCache, bentostore } from 'bentocache'
import { memoryDriver } from 'bentocache/drivers/memory'
import { redisDriver, redisBusDriver } from 'bentocache/drivers/redis'
import { getConfig } from '../config.js'
import { assertSafeIdentifier } from '../isthmus/guarded_identifier.js'

/**
 * Configuration shape consumed by buildCacheStack when assembling the package
 * cache. It carries the Redis connection coordinates (host, port, and optional
 * username, password, and database index) used for both the L2 store and the
 * cross-process invalidation bus, plus an optional l1MaxSizeBytes that caps the
 * in-process memory layer and defaults to 5 MiB when omitted.
 */
export interface CacheStackOptions {
  connection: {
    host: string
    port: number
    username?: string | null
    password?: string | null
    db?: number | null
  }
  /** L1 memory budget in bytes. Default: 5 MiB (the package singleton's). */
  l1MaxSizeBytes?: number
}

/**
 * Builds the package's cache stack: in-process memory L1, shared Redis L2,
 * and a Redis bus that invalidates peer L1s across processes. The singleton
 * below and the multi-pod coherency spec
 * (tests/integration/services/cache_bus_invalidation.spec.ts) both build
 * through here, so what the test proves is the wiring production runs,
 * not a hand-rolled copy that can drift.
 */
export function buildCacheStack(options: CacheStackOptions) {
  const { host, port, username, password, db } = options.connection
  const connection = {
    host,
    port,
    username: username ?? undefined,
    password: password ?? undefined,
    db: db ?? 0,
  }
  return new BentoCache({
    default: 'cache',
    stores: {
      cache: bentostore()
        .useL1Layer(memoryDriver({ maxSize: options.l1MaxSizeBytes ?? 5 * 1024 * 1024 }))
        .useL2Layer(redisDriver({ connection }))
        .useBus(redisBusDriver({ connection })),
    },
  })
}

function buildCache() {
  return buildCacheStack({ connection: getConfig().cache.redis })
}

type CacheInstance = ReturnType<typeof buildCache>
type CacheNamespace = ReturnType<CacheInstance['namespace']>
let _cache: CacheInstance | null = null

/**
 * The package-level BentoCache singleton (memory L1 + Redis L2 + bus
 * for cross-process invalidation). Shared across all tenants. Keys
 * MUST be namespaced before use, otherwise two tenants writing to the
 * same key would clobber each other. Most code should reach for
 * {@link cacheFor} instead and let it apply the tenant prefix.
 */
export function getCache(): CacheInstance {
  if (!_cache) _cache = buildCache()
  return _cache
}

/**
 * Returns a BentoCache namespace whose keys are prefixed with the
 * tenant's id (`tenant:<id>:`). Use this whenever you want to cache
 * something tenant-scoped. It makes accidental cross-tenant reads
 * impossible because every key the returned namespace produces lives
 * in a tenant-private prefix.
 *
 * The tenant id is validated through `assertSafeIdentifier` so a
 * crafted id can never escape the prefix or interpolate Redis
 * metacharacters.
 *
 * @example
 *   const cache = cacheFor(tenant)
 *   const settings = await cache.getOrSet({
 *     key: 'settings',
 *     factory: () => loadSettingsFromDb(tenant.id),
 *     ttl: 60_000,
 *   })
 */
export function cacheFor(tenant: { id: string } | string): CacheNamespace {
  const id = typeof tenant === 'string' ? tenant : tenant.id
  assertSafeIdentifier(id, 'tenant id')
  return getCache().namespace(`tenant:${id}`)
}
