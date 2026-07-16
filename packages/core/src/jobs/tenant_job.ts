import { Job } from '@adonisjs/queue'
import { tenancy } from '../tenancy.js'
import { resolveTenantRepository } from '../services/resolve_tenant_repository.js'
import type { TenantModelContract } from '../types/contracts.js'

/**
 * Minimum payload shape for a tenant-scoped job. Subclasses extend this with
 * their own fields. When `tenantId` is absent the job runs globally, with no
 * tenant context (see {@link TenantJob}).
 */
export interface TenantJobPayload {
  tenantId?: string
}

/**
 * Abstract base for queue jobs that need a tenant context. Subclasses implement
 * `perform()`; the base `execute()` resolves the tenant from `payload.tenantId`
 * and wraps `perform()` in `tenancy.run()`, so inside `perform()`:
 *
 *   - `TenantBaseModel` queries route to the tenant's schema,
 *   - `tenantCache()` / `tenantDisk()` / `tenantLogger()` resolve to the tenant,
 *   - `tenancy.currentId()` returns the tenant id.
 *
 * `tenancy.run()` already binds the log context AND the bootstrappers, so do NOT
 * wrap `perform()` in `logCtx.run()` yourself. That double-wraps the context.
 *
 * A job whose payload omits `tenantId` is treated as global: `perform()` runs
 * with no tenant scope. This is normal for cross-tenant maintenance jobs.
 *
 * Do not override `execute()`. That bypasses the automatic context. Built-in
 * jobs that must run *before* their schema exists (provisioning) deliberately
 * do not extend this base; they manage a lighter log-only context by hand.
 *
 * @example
 *   interface SendDigestPayload extends TenantJobPayload {
 *     userId: string
 *   }
 *
 *   export default class SendDigest extends TenantJob<SendDigestPayload> {
 *     static options = { name: 'app.SendDigest' }
 *
 *     protected async perform(): Promise<void> {
 *       const { userId } = this.payload
 *       // Tenant-scoped: models, cache, drive, logging all see this tenant.
 *       await Digest.buildFor(userId)
 *     }
 *   }
 */
export default abstract class TenantJob<
  TPayload extends TenantJobPayload = TenantJobPayload,
> extends Job<TPayload> {
  /**
   * Implement the tenant-scoped work here. Runs inside `tenancy.run()` when the
   * payload carries a `tenantId`, otherwise runs globally.
   */
  protected abstract perform(): Promise<void>

  /**
   * Resolve the tenant model for `payload.tenantId`. Defaults to the host's
   * bound repository; override in a subclass (or a test) to customise lookup.
   */
  protected async resolveTenant(tenantId: string): Promise<TenantModelContract> {
    const repo = await resolveTenantRepository()
    return repo.findByIdOrFail(tenantId)
  }

  async execute(): Promise<void> {
    const { tenantId } = this.payload

    // Global job: no tenant in the payload, so run without a scope.
    if (!tenantId) {
      return this.perform()
    }

    const tenant = await this.resolveTenant(tenantId)
    // `tenancy.run()` binds both the log context and the bootstrappers; never
    // also call `logCtx.run()` here or the context is double-wrapped.
    return tenancy.run(tenant, () => this.perform())
  }
}
