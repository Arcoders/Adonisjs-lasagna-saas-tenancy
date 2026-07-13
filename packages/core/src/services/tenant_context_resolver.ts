import { HttpContext } from '@adonisjs/core/http'
import type { HttpRequest } from '@adonisjs/core/http'
import assert from 'node:assert'
import IsthmusTenantMismatchException from '../exceptions/isthmus_tenant_mismatch_exception.js'
import MissingTenantHeaderException from '../exceptions/missing_tenant_header_exception.js'
import { memoizedTenantId, resolveTenantId } from '../extensions/request.js'
import { emitIsthmusEvent } from '../isthmus/audit.js'
import { isUuidV4 } from './isolation/identifier.js'
import type TenantResolverRegistry from './resolvers/registry.js'
import { tenancy } from '../tenancy.js'

/**
 * The single authority for "which tenant is active right now?", shared by the
 * `TenantAdapter` (routing every model query) and any other synchronous caller.
 * It folds what used to be three private adapter methods plus a per-request memo
 * symbol into one place, and consults ONE cached value — the tenant that
 * `request.tenant()` resolved (`memoizedTenantId`, which covers async `domain`
 * resolution) — falling back to the synchronous resolver chain.
 *
 * Resolution order for {@link currentId}:
 *   1. `tenancy.currentId()`, set by `tenancy.run(tenant, fn)` in queue jobs,
 *      scripts, custom commands;
 *   2. the HTTP request, via the chain-aware synchronous authority.
 *
 * The optional injected {@link TenantResolverRegistry} is the boot-seeded singleton
 * the provider passes; without one (a bare unit-test adapter) it delegates to the
 * module-level `resolveTenantId`, which builds the chain from config on demand. Both
 * reach the SAME chain the async `request.tenant()` uses, so a custom or domain-based
 * resolver routes model queries consistently.
 */
export default class TenantContextResolver {
  constructor(private readonly resolvers?: TenantResolverRegistry) {}

  /**
   * The active tenant id. `tenancy.run()` scope wins; otherwise the HTTP request.
   * Throws {@link MissingTenantHeaderException} when neither yields a valid UUID.
   *
   * With `{ seal: true }` (the ContextSeal, an Isthmus invariant): on the guarded
   * HTTP path BOTH sources are present — the guard wraps `next()` in
   * `tenancy.runForRequest`, so the scope and the request resolve the same tenant and
   * this is a string compare. When they DISAGREE (code inside a tenant-resolving
   * request entered `tenancy.run(otherTenant)`, context confusion), fail closed
   * instead of silently routing under the scope's tenant. Jobs and commands have no
   * HttpContext, so the seal is inert there.
   */
  currentId(opts?: { seal?: boolean }): string {
    const fromTenancy = tenancy.currentId()
    if (fromTenancy) {
      if (opts?.seal) {
        const context = HttpContext.get()
        if (context) {
          const fromRequest = this.#comparandId(context.request)
          if (fromRequest && fromRequest !== fromTenancy) {
            emitIsthmusEvent('seal.tenant_context', {
              tenantId: fromTenancy,
              metadata: { requestResolvedId: fromRequest },
            })
            throw new IsthmusTenantMismatchException(fromTenancy, fromRequest)
          }
        }
      }
      return fromTenancy
    }

    const context = HttpContext.get()
    if (!context) {
      throw new MissingTenantHeaderException()
    }
    const tenantId = this.#syncChainId(context.request)
    assert(tenantId && isUuidV4(tenantId), new MissingTenantHeaderException())
    return tenantId
  }

  /**
   * The HTTP side of the ContextSeal compare: the id the guard/macro already
   * resolved (`request.tenant()`, which covers async `domain` resolution), falling
   * back to the synchronous resolver chain. No per-request memo of its own — the
   * single cached value is `memoizedTenantId`; the sync chain is a pure, cheap
   * re-read, and a `null`/central result was never worth caching (the guard may
   * memoize the tenant later in the same request).
   */
  #comparandId(request: HttpRequest): string | undefined {
    return memoizedTenantId(request) ?? this.#syncChainId(request)
  }

  /**
   * Resolve a tenant id from the request through the SAME chain-aware authority
   * routing uses. A `domain` hit yields no synchronous id (it needs an async
   * repository lookup), so those flows must establish context via `request.tenant()`
   * first.
   */
  #syncChainId(request: HttpRequest): string | undefined {
    if (this.resolvers) {
      const result = this.resolvers.resolveSync(request)
      return result?.type === 'id' ? result.tenantId : undefined
    }
    return resolveTenantId(request)
  }
}
