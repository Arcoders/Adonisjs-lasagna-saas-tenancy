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

const lazyRedis = () =>
  import('@adonisjs/redis/services/main')
    .then((m) => m.default)
    .catch(() => null)

const lazyDb = () =>
  import('@adonisjs/lucid/services/db')
    .then((m) => m.default)
    .catch(() => null)

const lazyLogger = () =>
  import('@adonisjs/core/services/logger')
    .then((m) => m.default)
    .catch(() => null)

export default class CircuitBreakerService {
  private circuits = new Map<string, CircuitBreaker>()

  getCircuit(tenantId: string): CircuitBreaker {
    if (this.circuits.has(tenantId)) {
      return this.circuits.get(tenantId)!
    }

    const cfg = getConfig().circuitBreaker
    const connectionName = `${getConfig().tenantConnectionNamePrefix}${tenantId}`

    const probeFn = async () => {
      const db = await lazyDb()
      await db?.connection(connectionName).rawQuery('SELECT 1')
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
      const redis = await lazyRedis()
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
      const redis = await lazyRedis()
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
      const redis = await lazyRedis()
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
