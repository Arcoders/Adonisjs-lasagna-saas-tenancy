import { HttpContext } from '@adonisjs/core/http'
import type { HttpRequest } from '@adonisjs/core/http'
import type { Database } from '@adonisjs/lucid/database'
import type { LucidModel, ModelAdapterOptions } from '@adonisjs/lucid/types/model'
import assert from 'node:assert'
import { getConfig } from '../../config.js'
import MissingTenantHeaderException from '../../exceptions/missing_tenant_header_exception.js'
import { resolveTenantId } from '../../extensions/request.js'
import { isUuidV4 } from '../../services/isolation/identifier.js'
import type IsolationDriverRegistry from '../../services/isolation/registry.js'
import type TenantResolverRegistry from '../../services/resolvers/registry.js'
import { tenancy } from '../../tenancy.js'
import DefaultLucidAdapter from './default_lucid_adapter.js'

/**
 * Routes Lucid model queries to the right per-tenant connection by asking
 * the active `IsolationDriver` for the connection name.
 *
 * Resolution order for the active tenant id:
 *   1. Explicit `options.client` (already a connection)
 *   2. Explicit `options.connection` or `modelConstructor.connection`
 *   3. `tenancy.currentId()` — set by `tenancy.run(tenant, fn)` in queue
 *      jobs, scripts, custom commands
 *   4. The HTTP request resolver via `resolveTenantId(context.request)`
 */
export default class TenantAdapter extends DefaultLucidAdapter {
  constructor(
    db: Database,
    private readonly drivers: IsolationDriverRegistry,
    private readonly resolvers?: TenantResolverRegistry
  ) {
    super(db)
  }

  override modelConstructorClient(modelConstructor: LucidModel, options?: ModelAdapterOptions) {
    if (options?.client) {
      return options.client
    }

    const explicit = options?.connection || modelConstructor?.connection
    if (explicit) {
      return this.db.connection(explicit)
    }

    const tenantId = this.#resolveTenantId()
    const driver = this.drivers.active()
    // Refresh the in-use grace window so a request that runs longer than the
    // eviction grace period isn't picked as a victim mid-query. No-op on drivers
    // without a per-tenant pool (rowscope-pg).
    driver.markUsed?.(tenantId)
    return this.db.connection(driver.connectionName(tenantId))
  }

  /**
   * Pulls the active tenant id from `tenancy.run()` first, then from the
   * HTTP request. Throws if neither yields a valid id.
   */
  #resolveTenantId(): string {
    const fromTenancy = tenancy.currentId()
    if (fromTenancy) return fromTenancy

    const context = HttpContext.get()
    if (!context) {
      throw new MissingTenantHeaderException()
    }

    const tenantId = this.#resolveIdFromRequest(context.request)
    assert(tenantId && isUuidV4(tenantId), new MissingTenantHeaderException())
    return tenantId
  }

  /**
   * Resolve a tenant id directly from the request for the fallback path (no
   * active tenancy context). Honors `config.resolver.legacyAdapterFallback`:
   * the default (`false`) consults the resolver chain synchronously so custom
   * resolvers route model queries too; set it to `true` to restore the
   * historical `resolverStrategy`-only switch. A `domain` hit yields no
   * synchronous id (it needs an async repository lookup), so those flows must
   * establish context via `request.tenant()` first.
   */
  #resolveIdFromRequest(request: HttpRequest): string | undefined {
    const legacy = getConfig().resolver?.legacyAdapterFallback ?? false
    if (!legacy && this.resolvers) {
      const result = this.resolvers.resolveSync(request)
      return result?.type === 'id' ? result.tenantId : undefined
    }
    return resolveTenantId(request)
  }
}
