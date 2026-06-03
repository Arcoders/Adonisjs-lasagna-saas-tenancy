import { TENANT_REPOSITORY } from '../types/contracts.js'
import type {
  TenantRepositoryContract,
  TenantModelContract,
  TenantMetadata,
} from '../types/contracts.js'
import MissingTenantHeaderException from '../exceptions/missing_tenant_header_exception.js'
import TenantNotFoundException from '../exceptions/tenant_not_found_exception.js'
import { getConfig } from '../config.js'
import { getActiveDriver } from '../services/isolation/active_driver.js'
import { isUuidV4 } from '../services/isolation/identifier.js'
import TenantResolverRegistry from '../services/resolvers/registry.js'
import type { TenantResolveResult } from '../services/resolvers/resolver.js'
import { HttpRequest } from '@adonisjs/core/http'
import app from '@adonisjs/core/services/app'
import assert from 'node:assert'

declare module '@adonisjs/core/http' {
  interface HttpRequest {
    tenant<TMeta extends object = TenantMetadata>(): Promise<TenantModelContract<TMeta>>
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

;(HttpRequest as any).macro('tenant', async function (this: HttpRequest) {
  if ((this as any)[TENANT_MEMO_KEY]) {
    return (this as any)[TENANT_MEMO_KEY] as TenantModelContract
  }

  const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract

  const result = await resolveTenant(this)
  let tenant: TenantModelContract | null = null

  if (result?.type === 'id') {
    assert(isUuidV4(result.tenantId), new MissingTenantHeaderException())
    tenant = await repo.findById(result.tenantId, true)
  } else if (result?.type === 'domain') {
    tenant = await repo.findByDomain(result.domain)
  } else {
    throw new MissingTenantHeaderException()
  }

  if (!tenant) throw new TenantNotFoundException()

  const driver = await getActiveDriver()
  await driver.connect(tenant)
  ;(this as any)[TENANT_MEMO_KEY] = tenant
  return tenant
})
