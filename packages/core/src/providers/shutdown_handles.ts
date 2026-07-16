import type { ApplicationService } from '@adonisjs/core/types'
import TenantQueueService from '../services/tenant_queue_service.js'

/**
 * Close the long-lived libuv handles owned by core's container singletons so a
 * graceful SIGTERM (the `app.terminate()` a worker or web process runs on the
 * signal) lets the event loop drain instead of hanging until the orchestrator
 * SIGKILLs it after the termination grace period.
 *
 * `MultitenancyProvider.shutdown()` delegates here. The logic lives in its own
 * module (with no eager-boot static imports of its own) so the regression spec
 * can drive it against a fake container without standing up an Ignitor (the same
 * reason `shutdown_caches.ts` is extracted).
 *
 * Only {@link TenantQueueService} owns such a handle: it keeps a persistent
 * BullMQ `Queue` per dispatched-to tenant, each holding its own ioredis TCP
 * socket, and nothing else closes them (`app.terminate()` drains Lucid's pools
 * and the shared `@adonisjs/redis` connection, but not these). A worker that
 * processed an InstallTenant job leaves exactly one such socket referenced,
 * which was enough to survive SIGTERM. The other core singletons are clean on
 * this axis: `CircuitBreakerService`'s opossum timers are all `unref()`-ed, and
 * `QuotaService` / the rate limiter borrow the shared `@adonisjs/redis`
 * connection rather than opening their own.
 *
 * Resolving the singleton here is safe even in a process that never dispatched:
 * `make()` returns an empty instance and `closeAll()` is a no-op.
 */
export async function closeOwnedHandles(app: ApplicationService): Promise<void> {
  const queues = await app.container.make(TenantQueueService)
  await queues.closeAll()
}
