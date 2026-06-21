import CircuitBreaker from 'opossum'
import { getConfig } from '../config.js'

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface CircuitMetrics {
  state: CircuitState
  failures: number
  successes: number
  fallbackCalls: number
  tenantId: string
}

const REDIS_KEY_PREFIX = 'cb:state:'

/**
 * Upper bound on simultaneously-tracked tenant breakers. Each breaker holds two
 * opossum rolling-stats intervals, so an unbounded map under high tenant churn
 * leaks timers + memory. When exceeded we evict the oldest CLOSED breaker (it
 * re-creates cheaply on the next request); OPEN / HALF_OPEN breakers are kept
 * because they are actively failing fast and must not be dropped.
 */
const DEFAULT_MAX_TRACKED_CIRCUITS = 5_000

const lazyRedis = () =>
  import('@adonisjs/redis/services/main').then((m) => m.default).catch(() => null)

const lazyDb = () => import('@adonisjs/lucid/services/db').then((m) => m.default).catch(() => null)

const lazyLogger = () =>
  import('@adonisjs/core/services/logger').then((m) => m.default).catch(() => null)

export default class CircuitBreakerService {
  private circuits = new Map<string, CircuitBreaker>()

  /**
   * Override hook for tests: a spec can subclass and force the Redis calls to
   * fail without mutating the shared `@adonisjs/redis` singleton (which would
   * leak into sibling integration specs). Mirrors RateLimitMiddleware.getRedis.
   * Returns the manager, or null when Redis isn't bound (e.g. unit tests).
   */
  protected getRedis(): Promise<any> {
    return lazyRedis()
  }

  getCircuit(tenantId: string): CircuitBreaker {
    if (this.circuits.has(tenantId)) {
      return this.circuits.get(tenantId)!
    }

    const cfg = getConfig().circuitBreaker

    // Resolve the connection name from the active isolation driver rather than
    // hardcoding `${prefix}${tenantId}`: `database-pg` matches that shape, but
    // `rowscope-pg` shares one central connection, so the hardcoded name would
    // not exist and every probe would fail.
    const probeFn = async () => {
      const db = await lazyDb()
      if (!db) return
      const { getActiveDriver } = await import('./isolation/active_driver.js')
      const driver = await getActiveDriver()
      await db.connection(driver.connectionName(tenantId)).rawQuery('SELECT 1')
    }

    const breaker = new CircuitBreaker(probeFn, {
      timeout: 5000,
      errorThresholdPercentage: cfg.threshold,
      resetTimeout: cfg.resetTimeout,
      rollingCountTimeout: cfg.rollingCountTimeout,
      volumeThreshold: cfg.volumeThreshold,
      name: `tenant_${tenantId}`,
    })

    // The redundant `.catch(() => {})` on each #persistState call has
    // been removed: #persistState now logs failures itself, so an extra
    // outer swallow would only hide the diagnostic.
    breaker.on('open', async () => {
      const logger = await lazyLogger()
      logger?.warn({ tenantId }, 'Circuit OPEN — tenant DB unavailable')
      await this.#persistState(tenantId, 'OPEN')
    })

    breaker.on('close', async () => {
      const logger = await lazyLogger()
      logger?.info({ tenantId }, 'Circuit CLOSED — tenant DB recovered')
      await this.#persistState(tenantId, 'CLOSED')
    })

    breaker.on('halfOpen', async () => {
      const logger = await lazyLogger()
      logger?.info({ tenantId }, 'Circuit HALF_OPEN — probing tenant DB')
      await this.#persistState(tenantId, 'HALF_OPEN')
    })

    this.#evictIfOverCapacity()
    this.circuits.set(tenantId, breaker)
    // Best-effort restore: if this tenant's breaker was OPEN when the previous
    // process exited, re-open it now so we fail fast against a still-down tenant
    // DB instead of hammering it with 5s-timeout probes until the threshold
    // re-trips. This is fire-and-forget (a single Redis read). The breaker
    // self-heals from OPEN through HALF_OPEN to CLOSED from there, and the worst
    // case (the DB recovered during the restart) is a single bounded
    // resetTimeout delay before the first probe. Until now `cb:state:` was
    // written but never read back, so persisted state was dead weight across
    // restarts.
    void this.#restorePersistedState(tenantId, breaker)
    return breaker
  }

  /**
   * Re-open a freshly-created breaker when Redis says it was OPEN at the
   * last shutdown. No-op when Redis is unavailable or the state was not OPEN.
   */
  async #restorePersistedState(tenantId: string, breaker: CircuitBreaker): Promise<void> {
    try {
      const redis = await this.getRedis()
      const state = await redis?.get(`${REDIS_KEY_PREFIX}${tenantId}`)
      if (state === 'OPEN' && !breaker.opened) {
        breaker.open()
      }
    } catch (err) {
      const logger = await lazyLogger()
      logger?.warn(
        { tenantId, err: (err as Error)?.message ?? String(err) },
        'CircuitBreakerService: failed to restore persisted circuit state from Redis'
      )
    }
  }

  /**
   * Keep the breaker map bounded. When at/over capacity, shut down and drop the
   * oldest CLOSED breakers (Map preserves insertion order) until one slot is
   * free for the caller's add. Skips OPEN/HALF_OPEN breakers — they're actively
   * failing fast. If every tracked breaker is non-closed we let the map exceed
   * the bound briefly rather than drop a live one (matching the connection
   * LRU's "never sever an active resource" stance); evicting down to the cap
   * (not just one) lets the map DEFLATE again after such a burst.
   */
  #evictIfOverCapacity(): void {
    const max = getConfig().circuitBreaker?.maxTrackedCircuits ?? DEFAULT_MAX_TRACKED_CIRCUITS
    if (this.circuits.size < max) return
    for (const [tenantId, breaker] of this.circuits) {
      if (this.circuits.size < max) return
      if (!breaker.opened && !breaker.halfOpen) {
        breaker.shutdown()
        this.circuits.delete(tenantId)
      }
    }
  }

  isOpen(tenantId: string): boolean {
    if (!this.circuits.has(tenantId)) return false
    return this.circuits.get(tenantId)!.opened
  }

  getMetrics(tenantId: string): CircuitMetrics | null {
    const breaker = this.circuits.get(tenantId)
    if (!breaker) return null
    const stats = breaker.stats
    return {
      tenantId,
      state: breaker.opened ? 'OPEN' : breaker.halfOpen ? 'HALF_OPEN' : 'CLOSED',
      failures: stats.failures,
      successes: stats.successes,
      fallbackCalls: stats.fallbacks,
    }
  }

  getAllMetrics(): Record<string, CircuitMetrics> {
    const result: Record<string, CircuitMetrics> = {}
    for (const [tenantId] of this.circuits) {
      const m = this.getMetrics(tenantId)
      if (m) result[tenantId] = m
    }
    return result
  }

  reset(tenantId: string): void {
    const breaker = this.circuits.get(tenantId)
    if (breaker) {
      breaker.close()
      // Fire-and-forget: reset() is sync, but #persistState now logs its
      // own failures so we don't need an outer .catch.
      void this.#persistState(tenantId, 'CLOSED')
    }
  }

  async destroy(tenantId: string): Promise<void> {
    const breaker = this.circuits.get(tenantId)
    if (breaker) {
      breaker.shutdown()
      this.circuits.delete(tenantId)
    }
    try {
      const redis = await this.getRedis()
      await redis?.del(`${REDIS_KEY_PREFIX}${tenantId}`)
    } catch (err) {
      const logger = await lazyLogger()
      logger?.warn(
        { tenantId, err: (err as Error)?.message ?? String(err) },
        'CircuitBreakerService: failed to clear persisted state on destroy'
      )
    }
  }

  async #persistState(tenantId: string, state: CircuitState): Promise<void> {
    try {
      const redis = await this.getRedis()
      await redis?.setex(`${REDIS_KEY_PREFIX}${tenantId}`, 3600, state)
    } catch (err) {
      // Surface persistence failures: the in-memory breaker keeps
      // working, but ops needs to know that on a process restart we
      // would read STALE state from Redis (or none at all).
      const logger = await lazyLogger()
      logger?.warn(
        { tenantId, state, err: (err as Error)?.message ?? String(err) },
        'CircuitBreakerService: failed to persist circuit state to Redis — in-memory state may diverge from persisted state on restart'
      )
    }
  }
}
