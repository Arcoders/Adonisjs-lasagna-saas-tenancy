import type { WorkerOptions } from 'bullmq'
import { getConfig } from '../config.js'

/**
 * Build the per-tenant BullMQ `WorkerOptions` (Redis connection + name +
 * concurrency) a host needs to run a dedicated worker for one tenant's queue.
 * The package is dispatch-only — it never spawns a `Worker` — so the host owns
 * the `new Worker(getQueueName(tenantId), processor, opts)` call and its
 * lifecycle. This helper just assembles the options from `config.queue`.
 *
 * @param tenantId The tenant whose worker this is (used for the worker name).
 * @param concurrency Per-tenant parallel job ceiling. Defaults to
 *   `config.queue.defaultConcurrency`. Must be a finite integer >= 1.
 *
 * @example
 *   import { Worker } from 'bullmq'
 *   import { buildTenantWorkerOptions } from '@adonisjs-lasagna/saas-tenancy'
 *
 *   const opts = buildTenantWorkerOptions(tenantId, 3)
 *   const queueName = `${config.queue.tenantQueuePrefix}${tenantId}`
 *   const worker = new Worker(queueName, processor, opts)
 */
export function buildTenantWorkerOptions(tenantId: string, concurrency?: number): WorkerOptions {
  const queue = getConfig().queue
  const resolved = concurrency ?? queue.defaultConcurrency

  if (!Number.isFinite(resolved) || resolved < 1) {
    throw new Error(
      `buildTenantWorkerOptions: concurrency must be a finite integer >= 1, got ${resolved}`
    )
  }

  return {
    connection: {
      host: queue.redis.host,
      port: queue.redis.port,
      username: queue.redis.username ?? undefined,
      password: queue.redis.password ?? undefined,
      db: queue.redis.db ?? 0,
    },
    name: `tenant:${tenantId}`,
    concurrency: resolved,
  }
}
