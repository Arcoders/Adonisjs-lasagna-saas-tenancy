import { Queue, type JobsOptions } from 'bullmq'
import logger from '@adonisjs/core/services/logger'
import { getConfig } from '../config.js'

export interface TenantQueueStats {
  tenantId: string
  queueName: string
  waiting: number
  active: number
  completed: number
  failed: number
  delayed: number
}

/**
 * Per-tenant BullMQ queue access.
 *
 * Registered as a container singleton by `MultitenancyProvider` — resolve it
 * with `app.container.make(TenantQueueService)` rather than `new`-ing it.
 * The dispatch path keeps a persistent `Queue` per tenant (each owns an ioredis
 * connection); constructing a fresh service per call would leak one connection
 * per dispatch and would make `destroy()` / `getAllStats()` see an empty map.
 *
 * Read-only inspection (stats, active-job listing) deliberately uses
 * short-lived handles via {@link withTempQueue} so the polled doctor / admin /
 * metrics paths never accumulate open connections.
 */
export default class TenantQueueService {
  private queues = new Map<string, Queue>()

  getQueueName(tenantId: string): string {
    return `${getConfig().queue.tenantQueuePrefix}${tenantId}`
  }

  #connection() {
    const { redis: conn } = getConfig().queue
    return {
      host: conn.host,
      port: conn.port,
      username: conn.username ?? undefined,
      password: conn.password ?? undefined,
      db: conn.db ?? 0,
    }
  }

  getOrCreate(tenantId: string): Queue {
    if (this.queues.has(tenantId)) {
      return this.queues.get(tenantId)!
    }

    const { attempts } = getConfig().queue

    const queue = new Queue(this.getQueueName(tenantId), {
      connection: this.#connection(),
      defaultJobOptions: {
        attempts,
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    })

    logger.debug({ tenantId, queueName: this.getQueueName(tenantId) }, 'Tenant queue created')
    this.queues.set(tenantId, queue)
    return queue
  }

  /**
   * Run `fn` against a SHORT-LIVED queue handle and close it afterwards. Every
   * read-only inspection must go through here: a persistent handle per inspected
   * tenant leaks one ioredis connection per call on the doctor / admin / metrics
   * paths (which are polled), eventually exhausting Redis `maxclients`.
   */
  async withTempQueue<T>(tenantId: string, fn: (queue: Queue) => Promise<T>): Promise<T> {
    const queue = new Queue(this.getQueueName(tenantId), { connection: this.#connection() })
    try {
      return await fn(queue)
    } finally {
      await queue.close().catch(() => {})
    }
  }

  async #countsFor(tenantId: string, queue: Queue): Promise<TenantQueueStats> {
    const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed')
    return {
      tenantId,
      queueName: this.getQueueName(tenantId),
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
    }
  }

  async getStats(tenantId: string): Promise<TenantQueueStats> {
    return this.withTempQueue(tenantId, (queue) => this.#countsFor(tenantId, queue))
  }

  /**
   * Stats for an explicit set of tenants. Prefer this over {@link getAllStats}
   * when you have the tenant list (e.g. the /metrics collector) — it reflects
   * ALL tenants, not just the ones this process happened to dispatch to.
   */
  async statsForTenants(tenantIds: string[]): Promise<TenantQueueStats[]> {
    const results: TenantQueueStats[] = []
    for (const id of tenantIds) {
      results.push(await this.getStats(id))
    }
    return results
  }

  /**
   * Stats for the queues this process currently holds open (the dispatch path).
   * Cheap (no new connections) but per-process, so it only covers tenants this
   * instance has dispatched to. Use {@link statsForTenants} for a full view.
   */
  async getAllStats(): Promise<TenantQueueStats[]> {
    const results: TenantQueueStats[] = []
    for (const [tenantId, queue] of this.queues) {
      results.push(await this.#countsFor(tenantId, queue))
    }
    return results
  }

  async dispatch<T extends Record<string, unknown>>(
    tenantId: string,
    jobName: string,
    payload: T,
    opts?: JobsOptions
  ): Promise<void> {
    const queue = this.getOrCreate(tenantId)
    await queue.add(jobName, payload, opts)
  }

  async destroy(tenantId: string): Promise<void> {
    // Obliterate UNCONDITIONALLY — never depend on whether this process's
    // in-memory map happens to hold the queue. The worker running an uninstall
    // may have restarted since install created the handle, so a map-only
    // destroy would silently orphan the tenant's `bull:` keys in Redis (and a
    // queued job could later run against a dropped schema).
    const queue = this.queues.get(tenantId) ?? this.getOrCreate(tenantId)
    try {
      await queue.obliterate({ force: true })
      logger.info({ tenantId }, 'Tenant queue destroyed')
    } catch (error) {
      logger.warn({ tenantId, error: (error as Error).message }, 'Failed to destroy tenant queue')
    } finally {
      // Close in finally: if obliterate() throws, the Queue (and its ioredis
      // connection) must still be released — the map delete below drops our
      // only reference to it.
      await queue.close().catch(() => {})
      this.queues.delete(tenantId)
    }
  }
}
