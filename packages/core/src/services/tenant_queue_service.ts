import { Queue, type JobsOptions, type QueueOptions } from 'bullmq'
import { getConfig } from '../config.js'
import ConnectionLru from './isolation/connection_lru.js'

// Lazy logger so importing this service never triggers `@adonisjs/core`'s
// top-level `await app.booted(...)` outside an Ignitor (which throws). Matches
// the pattern in CircuitBreakerService / ConnectionLru / WebhookService and
// keeps the module importable from unit tests.
const lazyLogger = () =>
  import('@adonisjs/core/services/logger').then((m) => m.default).catch(() => null)

/** Default fan-out width when collecting stats for an explicit tenant list. */
export const DEFAULT_STATS_CONCURRENCY = 10

/**
 * A snapshot of BullMQ job counts for a single tenant's queue, identifying the
 * tenant and queue by name and reporting how many jobs sit in each BullMQ
 * state: waiting, active, completed, failed, and delayed. It is built from
 * `queue.getJobCounts(...)` and returned by the service's `getStats`,
 * `statsForTenants`, and `getAllStats` methods for doctor, admin, and metrics
 * inspection paths.
 */
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
 * Registered as a container singleton by `MultitenancyProvider`. Resolve it
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

  // Bounds the persistent dispatch-path handle map. Each `Queue` owns an
  // ioredis connection, so without this an app/worker that dispatches to many
  // distinct tenants over its lifetime would accumulate one open connection per
  // tenant forever (the read-only inspection path already dodges this via
  // `withTempQueue`). Mirrors the in-use-aware connection LRU: an idle handle is
  // closed when over cap; a handle touched within the grace window is never
  // evicted, so an in-flight dispatch is never severed.
  readonly #lru = new ConnectionLru({
    label: 'TenantQueueService',
    cap: () => getConfig().queue.maxOpenQueues,
    graceMs: () => getConfig().queue.queueIdleGraceMs,
    release: async (tenantId) => {
      // Delete synchronously (before the await) so a concurrent getOrCreate for
      // the same tenant re-creates a fresh handle instead of handing back the
      // one that is closing. The close() drains in the background.
      const queue = this.queues.get(tenantId)
      if (!queue) return
      this.queues.delete(tenantId)
      await queue.close()
    },
    now: () => this.now(),
  })

  /** Clock source for the handle LRU. A method seam so tests can drive eviction
   * deterministically instead of depending on `Date.now()` advancing. */
  protected now(): number {
    return Date.now()
  }

  /**
   * Number of persistent per-tenant queue handles currently held open on the
   * dispatch path. Bounded by `config.queue.maxOpenQueues`; exposed for the
   * doctor/metrics surface and to make the eviction bound testable.
   */
  get openHandleCount(): number {
    return this.queues.size
  }

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

  /**
   * Construct a BullMQ `Queue`. A method seam (not a bare `new Queue`) so unit
   * tests can exercise the handle-eviction logic with an in-memory stub instead
   * of a live ioredis connection.
   */
  protected createQueue(name: string, options: QueueOptions): Queue {
    return new Queue(name, options)
  }

  getOrCreate(tenantId: string): Queue {
    if (this.queues.has(tenantId)) {
      this.#lru.touch(tenantId)
      return this.queues.get(tenantId)!
    }

    const { attempts } = getConfig().queue

    const queue = this.createQueue(this.getQueueName(tenantId), {
      connection: this.#connection(),
      defaultJobOptions: {
        attempts,
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    })

    void lazyLogger().then((l) =>
      l?.debug({ tenantId, queueName: this.getQueueName(tenantId) }, 'Tenant queue created')
    )
    this.queues.set(tenantId, queue)
    this.#lru.touch(tenantId)
    // Reclaim an idle handle if this push put us over the cap. Fire-and-forget,
    // in-use-aware: never closes a handle dispatched to within the grace window.
    this.#lru.evictIfNeeded()
    return queue
  }

  /**
   * Run `fn` against a SHORT-LIVED queue handle and close it afterwards. Every
   * read-only inspection must go through here: a persistent handle per inspected
   * tenant leaks one ioredis connection per call on the doctor / admin / metrics
   * paths (which are polled), eventually exhausting Redis `maxclients`.
   */
  async withTempQueue<T>(tenantId: string, fn: (queue: Queue) => Promise<T>): Promise<T> {
    const queue = this.createQueue(this.getQueueName(tenantId), { connection: this.#connection() })
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
   * when you have the tenant list (e.g. the /metrics collector). It reflects
   * ALL tenants, not just the ones this process happened to dispatch to.
   *
   * Each tenant's counts come from a short-lived handle ({@link withTempQueue}),
   * so a naive sequential loop pays N connect/handshake/close cycles back to
   * back. This runs them in bounded-concurrency batches instead: peak open
   * connections never exceed `concurrency` (default 10) regardless of list size,
   * and the wall-clock drops by roughly that factor.
   */
  async statsForTenants(
    tenantIds: string[],
    concurrency: number = DEFAULT_STATS_CONCURRENCY
  ): Promise<TenantQueueStats[]> {
    const width = Math.max(1, concurrency)
    const results: TenantQueueStats[] = new Array(tenantIds.length)
    for (let i = 0; i < tenantIds.length; i += width) {
      const batch = tenantIds.slice(i, i + width)
      const stats = await Promise.all(batch.map((id) => this.getStats(id)))
      for (let j = 0; j < batch.length; j++) results[i + j] = stats[j]!
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

  /**
   * Close every persistent dispatch-path queue handle this process holds open,
   * releasing the ioredis connection each one owns, and clear the map + LRU
   * bookkeeping. The provider's `shutdown()` calls this so a SIGTERM'd worker or
   * web process doesn't leave a Redis socket keeping the event loop alive past
   * `app.terminate()` (the classic graceful-shutdown hang that ends in a SIGKILL once the grace period expires).
   *
   * Non-destructive, unlike {@link destroy}: it does NOT `obliterate` the
   * tenant's `bull:` keys. A queued job must survive a graceful restart; this
   * only drops the in-process connection, not the durable queue.
   *
   * Snapshots then clears the map synchronously (before any await) so a
   * concurrent `getOrCreate` racing the shutdown builds a fresh handle rather
   * than getting back one that is closing, mirroring the LRU release path. Closes
   * concurrently and swallows per-queue errors: one queue failing to close must
   * not strand the others' sockets open, which is exactly the hang this exists to
   * prevent.
   */
  async closeAll(): Promise<void> {
    const open = [...this.queues.entries()]
    this.queues.clear()
    for (const [tenantId] of open) this.#lru.delete(tenantId)
    await Promise.all(open.map(([, queue]) => queue.close().catch(() => {})))
  }

  async destroy(tenantId: string): Promise<void> {
    // Obliterate UNCONDITIONALLY. Never depend on whether this process's
    // in-memory map happens to hold the queue. The worker running an uninstall
    // may have restarted since install created the handle, so a map-only
    // destroy would silently orphan the tenant's `bull:` keys in Redis (and a
    // queued job could later run against a dropped schema).
    const queue = this.queues.get(tenantId) ?? this.getOrCreate(tenantId)
    try {
      await queue.obliterate({ force: true })
      ;(await lazyLogger())?.info({ tenantId }, 'Tenant queue destroyed')
    } catch (error) {
      ;(await lazyLogger())?.warn(
        { tenantId, error: (error as Error).message },
        'Failed to destroy tenant queue'
      )
    } finally {
      // Close in finally: if obliterate() throws, the Queue (and its ioredis
      // connection) must still be released. The map delete below drops our
      // only reference to it.
      await queue.close().catch(() => {})
      this.queues.delete(tenantId)
      // Keep the LRU bookkeeping in sync so the slot is freed and a later
      // re-create isn't shadowed by a stale entry.
      this.#lru.delete(tenantId)
    }
  }
}
