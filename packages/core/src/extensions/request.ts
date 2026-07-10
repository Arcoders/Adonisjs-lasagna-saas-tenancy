import { resolveTenantRepository } from '../services/resolve_tenant_repository.js'
import type {
  TenantRepositoryContract,
  TenantModelContract,
  TenantMetadata,
} from '../types/contracts.js'
import MissingTenantHeaderException from '../exceptions/missing_tenant_header_exception.js'
import TenantNotFoundException from '../exceptions/tenant_not_found_exception.js'
import RequestMacroCollisionException from '../exceptions/request_macro_collision_exception.js'
import { macroName, type MacroName } from '../sdk/brands.js'
import TenantSuspendedException from '../exceptions/tenant_suspended_exception.js'
import DependencyUnavailableException from '../exceptions/dependency_unavailable_exception.js'
import InvalidTenantIdentifierException from '../exceptions/invalid_tenant_identifier_exception.js'
import { getConfig } from '../config.js'
import { hostMatchesExpectedSuffix } from '../services/resolvers/builtins.js'
import type { ResolverCacheConfig } from '../types/config.js'
import { getActiveDriver } from '../services/isolation/active_driver.js'
import TelemetryService from '../services/telemetry_service.js'
import { isDependencyOutageError } from '../utils/dependency_outage.js'
import { isUuidV4, isSafeIdentifier } from '../services/isolation/identifier.js'
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
 * cache miss here means we're being called before boot finished, and we fall
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
 * Test-only: inject a resolution cache directly, skipping the container, so the
 * caching hot path can be exercised in a unit test without booting the app.
 */
export function __setResolutionCacheForTests(cache: TenantResolutionCache | undefined): void {
  cachedResolutionCache = cache
}

/**
 * Load a tenant by id, served from the per-process resolution cache when
 * `config.resolver.cache.enabled`.
 *
 * When the cache is disabled (or unavailable before boot), this falls straight
 * through to `repo.findById(id, includeDeleted)` honouring the caller's
 * `includeDeleted`, so the cache-off path is byte-for-byte the legacy behaviour
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
  let cacheCfg: ResolverCacheConfig | undefined
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
  cacheCfg: Pick<ResolverCacheConfig, 'ttlMs' | 'maxEntries'>
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
  let cacheCfg: ResolverCacheConfig | undefined
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
    // Mirror the registry resolvers' host allowlist on the legacy path too, so a
    // spoofed X-Forwarded-Host is refused regardless of which path resolves.
    if (!hostMatchesExpectedSuffix(host)) return undefined
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
    for (const raw of [request.qs()?.['tenant_id'], request.input('tenant_id')]) {
      if (raw === undefined || raw === null) continue
      // Present but not a string: fail closed (matches RequestDataResolver).
      if (typeof raw !== 'string') throw new InvalidTenantIdentifierException()
      if (raw.length > 0 && isUuidV4(raw)) return raw
    }
    return undefined
  }

  // header (default). Validate the client-controlled header against the same
  // `SAFE_IDENT` policy the drivers enforce before any id reaches SQL or a Redis
  // key: a header carrying `:` (key-structure injection) or other unsafe chars
  // must resolve to "no tenant" (fail-closed) rather than flow downstream into
  // an attribution key. UUIDs and opaque alphanumeric host ids still pass.
  const header = request.header(tenantHeaderKey)
  return isSafeIdentifier(header) ? header : undefined
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
 * async-friendly, so async work belongs to `resolveTenant()`.
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
 * Internal read seam for the Isthmus ContextSeal: the canonical id of the
 * tenant this request has already resolved (via `request.tenant()` / the
 * guard), if any. Covers async `domain` resolution, which the synchronous
 * resolver chain cannot see.
 */
export function memoizedTenantId(request: HttpRequest): string | undefined {
  const tenant = (request as any)[TENANT_MEMO_KEY] as TenantModelContract | undefined
  return tenant?.id
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

/**
 * True when an error already carries a decided HTTP status (an AdonisJS
 * exception with a numeric `.status`). The tenant lookup/connect catch sites
 * use this to pass such errors through untouched and wrap everything else as a
 * 503. The fail-closed-vs-pass-through contract lives here so a `statusCode`
 * vs `status` typo can't drift across the four call sites that depend on it.
 */
export function hasDecidedHttpStatus(err: unknown): err is { status: number } {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { status?: unknown }).status === 'number'
  )
}

/**
 * Map an error raised during the tenant resolve/connect phase (registry lookup,
 * circuit probe, driver connect) to the fail-closed response. A dependency
 * outage maps to a retry-able 503 EVEN IF it carries an HTTP status. Lucid tags
 * an unregistered-connection error (`E_UNMANAGED_DB_CONNECTION`, raised when a
 * tenant's pool was never established) with a 500, but it is a transient
 * connection-infrastructure failure, not a permanent decision. Any OTHER decided
 * status is respected (the hard-cap 503, a 500-class `IsolationConfig` misconfig
 * that is genuinely permanent). Everything else defaults to a 503. Returns the
 * exception to throw; the caller throws it so the control flow stays explicit.
 */
export function mapTenantConnectError(operation: string, err: unknown, tenantId?: string): unknown {
  if (isDependencyOutageError(err)) return dependencyUnavailable(operation, err, tenantId)
  if (hasDecidedHttpStatus(err)) return err
  return dependencyUnavailable(operation, err, tenantId)
}

/**
 * Map an error raised while a tenant request was running its handler (the
 * query phase, after connect succeeded). A backend severed mid-flight (a
 * failover, an admin `pg_terminate_backend`, a crash) otherwise bubbles a raw
 * Lucid 500 that reads as non-retryable, even though Postgres has already rolled
 * the transaction back. An outage maps to a clean, retry-able 503 even if it
 * carries a status; everything else (an ordinary constraint violation, an
 * application error, a deliberate 4xx) passes straight through so the host's
 * exception handler still owns it. The connect-phase analogue is
 * {@link mapTenantConnectError}.
 */
export function mapTenantQueryError(err: unknown, tenantId?: string): unknown {
  if (isDependencyOutageError(err)) return dependencyUnavailable('tenant.query', err, tenantId)
  return err
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

    // One span per request resolution covers resolve + lifecycle + connect, and
    // is stamped with the resolved tenant id so any deeper code (driver, adapter)
    // attaches to it. When no OTel provider is wired (the default), `withSpan`
    // opens a no-op span, so the slow path stays free in production.
    return TelemetryService.withSpan('tenancy.http.resolve', {}, async () => {
      const repo = await resolveTenantRepository()

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
        // Respect an error that already declares an HTTP status (a 400 missing
        // header, a 404 not-found, a 500 config fault): the layer that threw it
        // already decided the right response. A connection-infrastructure outage
        // (even one Lucid tags with a 500) maps to a clean, retry-able 503; any
        // other registry failure (central DB unreachable) likewise fails closed
        // as a 503 rather than leaking a raw Lucid error.
        throw mapTenantConnectError(
          'tenant.lookup',
          err,
          result?.type === 'id' ? result.tenantId : undefined
        )
      }

      if (!tenant) throw new TenantNotFoundException()

      // Fail closed on lifecycle, BEFORE connecting: a soft-deleted or
      // suspended tenant must not be served (nor have a pool opened for it)
      // just because a route group forgot the guard middleware. The guard still
      // runs its own richer checks (provisioning/failed, maintenance bypass,
      // circuit breaker); this is the order-independent floor underneath them.
      assertTenantActive(tenant, options)
      TelemetryService.setTenant(tenant.id)

      const driver = await getActiveDriver()
      try {
        await driver.connect(tenant)
      } catch (err) {
        // A connection-infrastructure outage (an unregistered-connection error
        // Lucid tags with a 500, Postgres down, ECONNREFUSED, timeout) maps to a
        // clean, retry-able 503. A genuinely decided status (the hard-cap 503
        // TenantConnectionLimit, the permanent 500 IsolationConfig misconfig)
        // still passes straight through.
        throw mapTenantConnectError('tenant.connect', err, tenant.id)
      }
      ;(this as any)[TENANT_MEMO_KEY] = tenant
      return tenant
    })
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

/**
 * A plugin-registered `request.<name>()` macro. Discriminated by `kind`. `name`
 * is branded (minted via `macroName()`). `resolve` computes the value from the
 * request; `requireTenant` fails closed if no tenant is resolved. Versioned under
 * the umbrella ABI (no per-surface contract constant).
 */
export interface TenantRequestMacroSpec<T = unknown> {
  readonly kind: 'requestMacro'
  readonly name: MacroName
  readonly resolve: (request: HttpRequest) => T | Promise<T>
  readonly requireTenant?: boolean
}

/** Names a plugin macro has claimed, to detect collisions across plugins. */
const registeredRequestMacros = new Map<string, symbol>()

/**
 * Install a `request.<name>()` macro that mirrors the built-in `tenant()` macro:
 * memoized per-request under a private `Symbol` (so repeated reads don't
 * recompute), fail-closed when `requireTenant` and no tenant resolves, and
 * COLLISION-checked: a name already taken by `tenant()`, another plugin's macro,
 * or an existing request property throws a {@link RequestMacroCollisionException}
 * rather than silently shadowing. Called by the `definePlugin` facade for each
 * `requestMacros` entry; also usable directly.
 */
export function registerTenantRequestMacro(spec: TenantRequestMacroSpec): void {
  // Re-validate the slug (idempotent, since a definePlugin entry already minted it
  // while a direct caller may not have): it becomes a prototype property and a Symbol tag.
  const name = macroName(spec.name)
  const proto = HttpRequest.prototype as unknown as Record<string, unknown>
  if (registeredRequestMacros.has(name) || typeof proto[name] === 'function') {
    throw new RequestMacroCollisionException(
      `request.${name}() is already defined; choose a unique macro name.`,
      { plugin: name }
    )
  }

  const memoKey = Symbol(`request_macro_${name}`)
  registeredRequestMacros.set(name, memoKey)
  ;(HttpRequest as any).macro(name, async function (this: HttpRequest) {
    const self = this as unknown as Record<symbol, unknown>
    // Presence check (not truthiness) so a macro legitimately resolving to a
    // falsy/undefined value memoizes once instead of recomputing every read.
    if (memoKey in self) return self[memoKey]
    if (spec.requireTenant) await this.tenant()
    const value = await spec.resolve(this)
    self[memoKey] = value
    return value
  })
}

/** Test-only: remove every plugin-registered request macro so a suite does not
 *  leak macros (or a collision) into the next. */
export function __resetRequestMacrosForTests(): void {
  const proto = HttpRequest.prototype as unknown as Record<string, unknown>
  for (const [name] of registeredRequestMacros) delete proto[name]
  registeredRequestMacros.clear()
}
