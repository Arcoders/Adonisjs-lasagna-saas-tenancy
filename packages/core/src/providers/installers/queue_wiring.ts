import TenantQueueService from '../../services/tenant_queue_service.js'
import type { InstallerContext, ProviderInstaller } from './installer.js'

/**
 * The per-tenant job queue. `TenantQueueService` is instance-stateful (holds a
 * per-tenant Queue map), so it MUST be a singleton — dispatch reuses connections
 * and destroy/stats see a consistent map. It is the only core singleton owning a
 * libuv handle (per-tenant BullMQ/ioredis sockets), which the provider drains in
 * shutdown via `closeOwnedHandles`.
 */
export const queueWiring: ProviderInstaller = {
  name: 'queue',

  register(ctx: InstallerContext): void {
    ctx.app.container.singleton(TenantQueueService, () => new TenantQueueService())
  },

  // Register package jobs with @adonisjs/queue's Locator. Host apps
  // auto-discover from `app/jobs/**`, which doesn't reach node_modules,
  // so without this dispatched InstallTenant/etc. dead-letter at the worker.
  // Best-effort: a host without @adonisjs/queue just skips it.
  async boot(ctx: InstallerContext): Promise<void> {
    try {
      const { Locator } = await import('@adonisjs/queue')
      const jobs = await import('../../jobs/index.js')
      for (const exported of Object.values(jobs)) {
        // Skip type-only re-exports, which erase to undefined at runtime.
        if (
          typeof exported !== 'function' ||
          typeof (exported as { dispatch?: unknown }).dispatch !== 'function'
        ) {
          continue
        }
        const JobClass = exported as { name: string; options?: { name?: string } }
        Locator.register(JobClass.options?.name ?? JobClass.name, JobClass as never)
      }
    } catch (error) {
      // Deferred to app.booted: this runs during boot(), before the eager
      // `@adonisjs/core/services/logger` binding exists (same constraint as the
      // rowscope warning), and a dropped warning here would hide a real dispatch gap.
      ctx.warnWhenBooted((logger) =>
        logger.warn(
          { err: (error as Error)?.message },
          '[multitenancy] could not auto-register queue jobs with the @adonisjs/queue Locator — dispatch a job through a worker only if you register them yourself'
        )
      )
    }
  },
}
