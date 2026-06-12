import { TENANT_REPOSITORY } from '../types/contracts.js'
import type {
  TenantRepositoryContract,
  TenantModelContract,
  TenantMetadata,
} from '../types/contracts.js'
import MissingTenantHeaderException from '../exceptions/missing_tenant_header_exception.js'
import TenantNotFoundException from '../exceptions/tenant_not_found_exception.js'
import TenantSuspendedException from '../exceptions/tenant_suspended_exception.js'
import DependencyUnavailableException from '../exceptions/dependency_unavailable_exception.js'
import { getConfig } from '../config.js'
import { getActiveDriver } from '../services/isolation/active_driver.js'
import { isUuidV4 } from '../services/isolation/identifier.js'
import { isProductionNodeEnv } from '../utils/env.js'
import TenantResolverRegistry from '../services/resolvers/registry.js'
import TenantResolutionCache, {
  DEFAULT_RESOLUTION_CACHE_MAX,
  DEFAULT_RESOLUTION_CACHE_TTL_MS,
} from '../services/tenant_resolution_cache.js'
import type { TenantResolveResult } from '../services/resolvers/resolver.js'
import { HttpRequest } from '@adonisjs/core/http'
import app from '@adonisjs/core/services/app'
import assert from 'node:assert'

declare module '@adonisjs/core/http' {
  interface HttpRequest {
    /**
     * Resolve, validate, connect, and memoize the request's tenant.
     *
     * Fail-closed on lifecycle: a soft-deleted or suspended tenant throws a
     * 403 `TenantSuspendedException` even on routes that never ran the guard
     * middleware, so forgetting the guard on a route group cannot serve a
     * suspended tenant. Admin/recovery flows that legitimately need an
     * inactive tenant opt in with `{ allowInactive: true }`.
     */
    tenant<TMeta extends object = TenantMetadata>(options?: {
      allowInactive?: boolean
    }): Promise<TenantModelContract<TMeta>>
  }
}

/**
 * Cached registry handle. The provider seeds the registry at boot, so a
 * cache miss here means we're being called before boot finished — fall
 * back to the synchronous strategy switch so unit tests still work.
 */
let cachedResolverRegistry: TenantResolverRegistry | undefined

async function getResolverRegistry(): Promise<TenantResolverRegistry | undefined> {
  if (cachedResolverRegistry) return cachedResolverRegistry
  try {
    cachedResolverRegistry = await app.container.make(TenantResolverRegistry)
    return cachedResolverRegistry
  } catch {
    return undefined
  }
}

export function __resetResolverRegistryCacheForTests(): void {
  cachedResolverRegistry = undefined
}

/**
 * Cached handle to the per-process tenant-resolution cache singleton. Resolved
 * lazily (a miss before boot just disables caching and falls through to the DB).
 */
let cachedResolutionCache: TenantResolutionCache | undefined

async function getResolutionCache(): Promise<TenantResolutionCache | undefined> {
  if (cachedResolutionCache) return cachedResolutionCache
  try {
    cachedResolutionCache = await app.container.make(TenantResolutionCache)
    return cachedResolutionCache
  } catch {
    return undefined
  }
}

export function __resetResolutionCacheRefForTests(): void {
  cachedResolutionCache = undefined
}

/**
 * Test-only: inject a resolution cache directly, skipping the container — so the
 * caching hot path can be exercised in a unit test without booting the app.
 */
export function __setResolutionCacheForTests(cache: TenantResolutionCache | undefined): void {
  cachedResolutionCache = cache
}

/**
 * Load a tenant by id, served from the per-process resolution cache when
 * `config.resolver.cache.enabled` (P1-1).
 *
 * When the cache is disabled (or unavailable before boot), this falls straight
 * through to `repo.findById(id, includeDeleted)` honouring the caller's
 * `includeDeleted` — so the cache-off path is byte-for-byte the legacy behaviour
 * (the guard passes `true`, the universal middleware passes `false`).
 *
 * When the cache IS enabled, a single entry per tenant is shared across call
 * sites, so the backing fetch always uses `includeDeleted=true` (the superset):
 * the guard inspects `isDeleted` itself, and the universal middleware likewise
 * degrades a soft-deleted tenant to `null` via its own `isDeleted` check. That
 * one cached entry is the whole point of the optimization.
 */
export async function findTenantByIdCached(
  repo: TenantRepositoryContract,
  id: string,
  includeDeleted: boolean = true
): Promise<TenantModelContract | null> {
  let cacheCfg: { enabled?: boolean; ttlMs?: number; maxEntries?: number } | undefined
  try {
    cacheCfg = getConfig().resolver?.cache
  } catch {
    cacheCfg = undefined
  }
  if (!cacheCfg?.enabled) return repo.findById(id, includeDeleted)

  const cache = await getResolutionCache()
  if (!cache) return repo.findById(id, includeDeleted)

  const hit = cache.get(id)
  if (hit) return hit

  const tenant = await findThenCache(repo, id, cache, cacheCfg)
  return tenant
}

async function findThenCache(
  repo: TenantRepositoryContract,
  id: string,
  cache: TenantResolutionCache,
  cacheCfg: { ttlMs?: number; maxEntries?: number }
): Promise<TenantModelContract | null> {
  const tenant = await repo.findById(id, true)
  if (tenant) {
    cache.set(
      id,
      tenant,
      cacheCfg.ttlMs ?? DEFAULT_RESOLUTION_CACHE_TTL_MS,
      cacheCfg.maxEntries ?? DEFAULT_RESOLUTION_CACHE_MAX
    )
  }
  return tenant
}

/**
 * Prime the resolution cache with a tenant the caller already loaded by another
 * key (e.g. the custom-domain middleware, which resolves by `findByDomain` and
 * then rewrites the request to the tenant id). Without this, the guard's
 * subsequent by-id lookup would miss the cache on the first request and hit the
 * DB a second time for the same tenant. No-op when the cache is disabled.
 */
export async function primeResolvedTenant(tenant: TenantModelContract): Promise<void> {
  let cacheCfg: { enabled?: boolean; ttlMs?: number; maxEntries?: number } | undefined
  try {
    cacheCfg = getConfig().resolver?.cache
  } catch {
    return
  }
  if (!cacheCfg?.enabled) return
  const cache = await getResolutionCache()
  cache?.set(
    tenant.id,
    tenant,
    cacheCfg.ttlMs ?? DEFAULT_RESOLUTION_CACHE_TTL_MS,
    cacheCfg.maxEntries ?? DEFAULT_RESOLUTION_CACHE_MAX
  )
}

/**
 * Synchronous fallback used when the resolver registry hasn't been seeded
 * yet (typically only inside the `TenantAdapter` query path before the
 * provider has booted, or in unit tests that don't boot the app). Mirrors
 * the v1 strategy switch verbatim.
 */
function legacyResolveTenantId(request: HttpRequest): string | undefined {
  const { resolverStrategy, tenantHeaderKey, baseDomain } = getConfig()

  if (resolverStrategy === 'subdomain' || resolverStrategy === 'domain-or-subdomain') {
    const hostname = request.hostname()
    const host = hostname?.split(':')[0] ?? ''
    const suffix = baseDomain.startsWith('.') ? baseDomain : `.${baseDomain}`
    if (host.endsWith(suffix)) {
      const sub = host.slice(0, host.length - suffix.length)
      return sub || undefined
    }
    if (host === baseDomain) return undefined
    // Dev-only leftmost-label fallback (mirrors SubdomainResolver). Production
    // refuses an off-baseDomain host rather than guessing a tenant from it.
    if (isProductionNodeEnv()) return undefined
    const labels = host.split('.')
    return labels.length > 1 ? labels[0] : undefined
  }

  if (resolverStrategy === 'path') {
    const segment = request.url(false).split('/').find(Boolean)
    return segment || undefined
  }

  if (resolverStrategy === 'request-data') {
    const fromQuery = request.qs()?.['tenant_id']
    if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery
    const fromBody = (request as any).input?.('tenant_id')
    if (typeof fromBody === 'string' && fromBody.length > 0) return fromBody
    return undefined
  }

  // header (default)
  return request.header(tenantHeaderKey) ?? undefined
}

/**
 * Returns the tenant id as a string, OR a `{ domain }` envelope, OR
 * `undefined`. Used by the `request.tenant()` macro and by
 * `TenantAdapter`. Async because resolvers may go async; the legacy
 * sync path is preserved for `TenantAdapter`'s synchronous call site
 * via {@link resolveTenantIdSync}.
 */
export async function resolveTenant(request: HttpRequest): Promise<TenantResolveResult> {
  const registry = await getResolverRegistry()
  if (registry && registry.chain().length > 0) {
    return registry.resolve(request)
  }
  const id = legacyResolveTenantId(request)
  return id ? { type: 'id', tenantId: id } : undefined
}

/**
 * Synchronous tenant-id resolver. Kept for `TenantAdapter`, which needs
 * to decide a connection name in a sync codepath. The new resolvers are
 * async-friendly — async work belongs to `resolveTenant()`.
 */
export function resolveTenantId(request: HttpRequest): string | undefined {
  return legacyResolveTenantId(request)
}

const TENANT_MEMO_KEY = Symbol('resolved_tenant')

/**
 * Internal helper to seed the tenant memo on a request without going through
 * the resolver. Consumed by `@adonisjs-lasagna/saas-tenancy/testing`.
 */
export function __setMemoizedTenant(request: HttpRequest, tenant: TenantModelContract): void {
  ;(request as any)[TENANT_MEMO_KEY] = tenant
}

/**
 * Build a 503 for a tenant-backend outage, preserving the original error as
 * `cause` for logs. Used when the tenant registry (central DB) or the tenant's
 * own connection is unreachable: a raw 500 from Lucid is opaque and reads as
 * non-retryable, so we map it to a clean, retry-able 503 instead. Exported for
 * the universal middleware, which applies the same policy.
 */
export function dependencyUnavailable(
  operation: string,
  cause: unknown,
  tenantId?: string
): DependencyUnavailableException {
  const exc = new DependencyUnavailableException({ dependency: 'postgres', operation, tenantId })
  ;(exc as any).cause = cause
  return exc
}

;(HttpRequest as any).macro(
  'tenant',
  async function (this: HttpRequest, options?: { allowInactive?: boolean }) {
    const memoized = (this as any)[TENANT_MEMO_KEY] as TenantModelContract | undefined
    if (memoized) {
      // Re-check on every read: an earlier `allowInactive: true` call must not
      // leak an inactive tenant into a later strict call through the memo.
      assertTenantActive(memoized, options)
      return memoized
    }

    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract

    const result = await resolveTenant(this)
    let tenant: TenantModelContract | null = null

    try {
      if (result?.type === 'id') {
        assert(isUuidV4(result.tenantId), new MissingTenantHeaderException())
        tenant = await findTenantByIdCached(repo, result.tenantId)
      } else if (result?.type === 'domain') {
        tenant = await repo.findByDomain(result.domain)
      } else {
        throw new MissingTenantHeaderException()
      }
    } catch (err) {
      // Respect an error that already declares an HTTP status — a 400 missing
      // header, a 404 not-found, a 500 config fault: the layer that threw it
      // already decided the right response. Anything else is the tenant registry
      // (central DB) being unreachable, so fail closed with a 503 rather than
      // leaking a raw Lucid 500. A host repository that wants a specific status
      // for its own errors should throw an Exception carrying one.
      if (typeof (err as any)?.status === 'number') throw err
      throw dependencyUnavailable(
        'tenant.lookup',
        err,
        result?.type === 'id' ? result.tenantId : undefined
      )
    }

    if (!tenant) throw new TenantNotFoundException()

    // Fail closed on lifecycle (P2-3), BEFORE connecting: a soft-deleted or
    // suspended tenant must not be served — nor have a pool opened for it —
    // just because a route group forgot the guard middleware. The guard still
    // runs its own richer checks (provisioning/failed, maintenance bypass,
    // circuit breaker); this is the order-independent floor underneath them.
    assertTenantActive(tenant, options)

    const driver = await getActiveDriver()
    try {
      await driver.connect(tenant)
    } catch (err) {
      // Respect a decided HTTP status: the hard-cap 503 (TenantConnectionLimit)
      // and the 500 misconfig (IsolationConfig) both carry one and pass straight
      // through. Any other connect failure (Postgres down, ECONNREFUSED, timeout)
      // is a raw backend outage — map it to a clean, retry-able 503 instead of
      // letting a raw Lucid error bubble up as an opaque 500.
      if (typeof (err as any)?.status === 'number') throw err
      throw dependencyUnavailable('tenant.connect', err, tenant.id)
    }
    ;(this as any)[TENANT_MEMO_KEY] = tenant
    return tenant
  }
)

/**
 * The lifecycle floor for `request.tenant()`: deleted/suspended tenants are
 * rejected with the same 403 the guard middleware would produce, unless the
 * caller explicitly opted into inactive tenants (admin/recovery flows).
 */
function assertTenantActive(
  tenant: TenantModelContract,
  options?: { allowInactive?: boolean }
): void {
  if (options?.allowInactive) return
  if (tenant.isDeleted || tenant.isSuspended) {
    throw new TenantSuspendedException()
  }
}
