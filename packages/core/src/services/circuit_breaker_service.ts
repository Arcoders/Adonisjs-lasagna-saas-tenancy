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
 * (or a fleet-wide outage that opens every tenant) leaks timers + memory. When
 * exceeded we evict the oldest CLOSED or OPEN breaker: a CLOSED one re-creates
 * cheaply, and an OPEN one keeps failing fast through its lightweight `markers`
 * entry after the heavy object is shed. Only HALF_OPEN breakers are spared (one
 * is mid recovery-probe). See {@link CircuitBreakerService.markers}.
 */
const DEFAULT_MAX_TRACKED_CIRCUITS = 5_000

/**
 * Ceiling on the `SELECT 1` probe before opossum counts a timeout as a failure.
 * This is the single value that decides how long a tenant request blocks on a
 * dead DB before the breaker trips, so it overrides opossum's 10s default with
 * a tighter bound.
 */
const PROBE_TIMEOUT_MS = 5_000

/**
 * TTL on the persisted breaker state in Redis. Bounds how long an OPEN state
 * survives a process restart before it self-heals through HALF_OPEN.
 */
const PERSISTED_STATE_TTL_SECONDS = 60 * 60

/**
 * Fallback breaker tuning used when the config omits `circuitBreaker` (or a field
 * of it). `circuitBreaker` is a required field of `MultitenancyConfig`, so a typed
 * config (`defineConfig`) always supplies it; this only keeps an untyped or
 * dynamically-assembled config from crashing the guarded request path, where the
 * breaker now fires on every request. Values mirror the documented examples.
 */
const CIRCUIT_BREAKER_DEFAULTS = {
  threshold: 50,
  resetTimeout: 30_000,
  rollingCountTimeout: 10_000,
  volumeThreshold: 5,
} as const

const lazyRedis = () =>
  import('@adonisjs/redis/services/main').then((m) => m.default).catch(() => null)

const lazyDb = () => import('@adonisjs/lucid/services/db').then((m) => m.default).catch(() => null)

const lazyLogger = () =>
  import('@adonisjs/core/services/logger').then((m) => m.default).catch(() => null)

export default class CircuitBreakerService {
  private circuits = new Map<string, CircuitBreaker>()

  /**
   * Lightweight fail-fast markers, DECOUPLED from the heavy opossum breakers.
   * Keyed by tenant id, the value is the epoch-ms deadline until which the
   * tenant fails fast (mirrors opossum's OPEN→HALF_OPEN `resetTimeout` window).
   *
   * This is what lets {@link isOpen}/{@link run} answer "is this tenant tripped?"
   * synchronously WITHOUT the opossum object, so a heavy OPEN breaker can be
   * evicted under memory pressure (a fleet-wide outage opens every tenant, and
   * each breaker holds two rolling-stats intervals) while fast-fail survives.
   * An entry is set the instant a breaker opens, cleared when it half-opens /
   * closes / is reset / destroyed, and treated as gone once its deadline passes
   * (the tenant would be HALF_OPEN, so a probe is allowed through again).
   */
  private markers = new Map<string, number>()

  /**
   * Clock seam. Real time in production; a spec can subclass and advance a fake
   * clock to drive the marker across its window deterministically (opossum's own
   * timers stay real, so this only governs the marker). Mirrors getRedis/buildProbe.
   */
  protected now(): number {
    return Date.now()
  }

  /** True while the tenant's fail-fast marker is set and its deadline is in the future. */
  #markerOpen(tenantId: string): boolean {
    const openUntil = this.markers.get(tenantId)
    return openUntil !== undefined && openUntil > this.now()
  }

  /** An opossum-shaped fast-fail error so callers' isOpenRejection() still classifies it. */
  #openRejection(): Error {
    const err = new Error('Breaker is open') as Error & { code?: string }
    err.code = 'EOPENBREAKER'
    return err
  }

  /**
   * Override hook for tests: a spec can subclass and force the Redis calls to
   * fail without mutating the shared `@adonisjs/redis` singleton (which would
   * leak into sibling integration specs). Mirrors RateLimitMiddleware.getRedis.
   * Returns the manager, or null when Redis isn't bound (e.g. unit tests).
   */
  protected getRedis(): Promise<any> {
    return lazyRedis()
  }

  /**
   * The connectivity action the breaker fires. Resolves the connection name from
   * the active isolation driver rather than hardcoding `${prefix}${tenantId}`:
   * `database-pg` matches that shape, but `rowscope-pg` shares one central
   * connection, so the hardcoded name would not exist and every probe would
   * fail. Overridable in tests to inject a deterministic success/failure without
   * a live database (mirrors the `getRedis` seam).
   */
  protected buildProbe(tenantId: string): () => Promise<void> {
    return async () => {
      const db = await lazyDb()
      if (!db) return
      const { getActiveDriver } = await import('./isolation/active_driver.js')
      const driver = await getActiveDriver()
      await db.connection(driver.connectionName(tenantId)).rawQuery('SELECT 1')
    }
  }

  getCircuit(tenantId: string): CircuitBreaker {
    if (this.circuits.has(tenantId)) {
      return this.circuits.get(tenantId)!
    }

    // Read defensively: `circuitBreaker` is required in the type, but the breaker
    // now fires on every guarded request, so an untyped/partial config that omits
    // it must degrade to safe defaults rather than throw per request (which the
    // guard would map to a 503). Mirrors the `?? DEFAULT` style in #evictIfOverCapacity.
    const cfg = getConfig().circuitBreaker
    const resetTimeout = cfg?.resetTimeout ?? CIRCUIT_BREAKER_DEFAULTS.resetTimeout

    const breaker = new CircuitBreaker(this.buildProbe(tenantId), {
      timeout: PROBE_TIMEOUT_MS,
      errorThresholdPercentage: cfg?.threshold ?? CIRCUIT_BREAKER_DEFAULTS.threshold,
      resetTimeout,
      rollingCountTimeout: cfg?.rollingCountTimeout ?? CIRCUIT_BREAKER_DEFAULTS.rollingCountTimeout,
      volumeThreshold: cfg?.volumeThreshold ?? CIRCUIT_BREAKER_DEFAULTS.volumeThreshold,
      name: `tenant_${tenantId}`,
    })

    // The marker mutation is the FIRST synchronous statement in each handler,
    // before any `await`, so the fast-fail state is authoritative the instant
    // opossum emits the transition (a caller reading isOpen() right after a
    // `.open()` sees it immediately). The redundant `.catch(() => {})` on each
    // #persistState call was removed: #persistState logs its own failures.
    breaker.on('open', async () => {
      this.markers.set(tenantId, this.now() + resetTimeout)
      const logger = await lazyLogger()
      logger?.warn({ tenantId }, 'Circuit OPEN — tenant DB unavailable')
      await this.#persistState(tenantId, 'OPEN')
    })

    breaker.on('close', async () => {
      this.markers.delete(tenantId)
      const logger = await lazyLogger()
      logger?.info({ tenantId }, 'Circuit CLOSED — tenant DB recovered')
      await this.#persistState(tenantId, 'CLOSED')
    })

    breaker.on('halfOpen', async () => {
      // HALF_OPEN means the window elapsed and opossum is letting one trial probe
      // through, so the tenant is no longer failing fast: drop the marker.
      this.markers.delete(tenantId)
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
    //
    // Gate on marker absence: a present marker means we are RE-creating a breaker
    // we just evicted under memory pressure (run() drops through an elapsed
    // marker), where the marker already governs fast-fail. Reading Redis then
    // would re-open the very breaker we shed and block the self-heal probe. A
    // genuine cold miss (empty map after a restart) has no marker, so restore runs.
    if (!this.markers.has(tenantId)) {
      void this.#restorePersistedState(tenantId, breaker)
    }
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
   * oldest breakers (Map preserves insertion order) until the map is back under
   * the cap. CLOSED breakers re-create cheaply. OPEN breakers are ALSO shed here
   * — the memory pressure a fleet-wide outage creates is precisely a map full of
   * OPEN breakers, each holding two rolling-stats intervals; their fail-fast
   * decision is preserved by the lightweight {@link markers} entry, so the heavy
   * opossum object goes while isOpen()/run() keep fast-failing.
   *
   * HALF_OPEN breakers are spared: one is mid-probe, so evicting it drops an
   * in-flight recovery check. If every tracked breaker is HALF_OPEN we let the
   * map exceed the bound briefly rather than sever a live probe (matching the
   * connection LRU's "never sever an active resource" stance); evicting down to
   * the cap (not just one) lets the map DEFLATE again after such a burst.
   */
  #evictIfOverCapacity(): void {
    const max = getConfig().circuitBreaker?.maxTrackedCircuits ?? DEFAULT_MAX_TRACKED_CIRCUITS
    if (this.circuits.size < max) return
    for (const [tenantId, breaker] of this.circuits) {
      if (this.circuits.size < max) return
      if (breaker.halfOpen) continue
      if (breaker.opened) {
        // Preserve the fast-fail decision across the eviction. The 'open' handler
        // set the marker; refresh it defensively in case it is somehow missing.
        this.#ensureOpenMarker(tenantId)
      }
      breaker.shutdown()
      this.circuits.delete(tenantId)
    }
  }

  /** Ensure a fast-fail marker exists for an OPEN tenant we are about to evict. */
  #ensureOpenMarker(tenantId: string): void {
    if (this.markers.has(tenantId)) return
    const resetTimeout =
      getConfig().circuitBreaker?.resetTimeout ?? CIRCUIT_BREAKER_DEFAULTS.resetTimeout
    this.markers.set(tenantId, this.now() + resetTimeout)
  }

  isOpen(tenantId: string): boolean {
    // The lightweight marker is authoritative and survives eviction of the heavy
    // breaker, so consult it first. Once its window elapses fall through to the
    // breaker's own view (it may still exist and be HALF_OPEN / recovered).
    if (this.#markerOpen(tenantId)) return true
    const breaker = this.circuits.get(tenantId)
    return breaker ? breaker.opened : false
  }

  /**
   * Exercise the tenant's breaker by firing its connectivity probe THROUGH the
   * breaker, so repeated failures actually TRIP it. Without a call site that
   * fires the breaker it can never accumulate failures and never opens (it was
   * previously only read via {@link isOpen}, so it was dead). The request
   * middlewares call this on the tenant connect step.
   *
   * Resolves when the probe succeeds. Rejects with an opossum `EOPENBREAKER`
   * error when the breaker is already OPEN (fast-fail, the probe is skipped), or
   * with the probe's own error when it fails while CLOSED/HALF_OPEN. Use
   * {@link isOpenRejection} (or re-check {@link isOpen}) to tell the two apart.
   */
  async run(tenantId: string): Promise<void> {
    // Fast-fail from the marker WITHOUT materializing the heavy breaker (it may
    // have been evicted under memory pressure). Mirror opossum's EOPENBREAKER so
    // isOpenRejection() still classifies it.
    if (this.#markerOpen(tenantId)) throw this.#openRejection()
    // Marker window elapsed (or none): let a probe through. getCircuit() FIRST,
    // while a stale marker (if any) still suppresses the Redis restore, so a
    // breaker we evicted re-creates CLOSED rather than being re-opened from
    // persisted state; then drop the marker so the fresh probe can run (the
    // recreate-on-HALF_OPEN path). fire() re-creates the breaker if it was shed.
    const staleMarker = this.markers.has(tenantId)
    const breaker = this.getCircuit(tenantId)
    if (staleMarker) this.markers.delete(tenantId)
    await breaker.fire()
  }

  /** True when an error thrown by {@link run} is opossum's "breaker is OPEN" fast-fail. */
  isOpenRejection(err: unknown): boolean {
    return (err as { code?: unknown })?.code === 'EOPENBREAKER'
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
    // Clear the fast-fail marker first so an evicted-but-open tenant (heavy
    // breaker already shed, only the marker left) also stops fast-failing.
    const hadMarker = this.markers.delete(tenantId)
    const breaker = this.circuits.get(tenantId)
    if (breaker) breaker.close()
    // Persist CLOSED when there was something to reset (a live breaker or a
    // lingering marker), so a restart doesn't restore a stale OPEN. A reset on a
    // wholly-unknown tenant stays a true no-op (no Redis write).
    if (breaker || hadMarker) {
      // Fire-and-forget: reset() is sync, but #persistState now logs its
      // own failures so we don't need an outer .catch.
      void this.#persistState(tenantId, 'CLOSED')
    }
  }

  async destroy(tenantId: string): Promise<void> {
    this.markers.delete(tenantId)
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
      await redis?.setex(`${REDIS_KEY_PREFIX}${tenantId}`, PERSISTED_STATE_TTL_SECONDS, state)
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
