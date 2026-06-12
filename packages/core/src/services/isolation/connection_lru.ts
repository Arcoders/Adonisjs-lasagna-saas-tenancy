const lazyLogger = () =>
  import('@adonisjs/core/services/logger').then((m) => m.default).catch(() => null)

/** Default cap on simultaneously-open tenant connections in Lucid's manager. */
export const DEFAULT_MAX_TENANT_CONNECTIONS = 50

/**
 * Default in-use grace window (ms). A connection touched more recently than
 * this is treated as serving a request and is never evicted, even over cap.
 * Set comfortably above your p99 request duration.
 */
export const DEFAULT_EVICTION_GRACE_MS = 30_000

export interface ConnectionLruOptions {
  /** Human-readable owner for log lines (e.g. `'SchemaPgDriver'`). */
  label: string
  /** Max entries before eviction kicks in. Read lazily so config changes apply. */
  cap: () => number
  /** In-use grace window in ms. Read lazily. */
  graceMs: () => number
  /**
   * When this returns true, the cap is a HARD cap: callers should refuse a new
   * connection (see `atHardLimit`) instead of exceeding it. Read lazily.
   * Defaults to false (the legacy "exceed the cap rather than sever" behavior).
   */
  hardCap?: () => boolean
  /** Close + unregister a connection by name. */
  release: (name: string) => Promise<void>
  /** Clock source. Defaults to `Date.now`; injectable for deterministic tests. */
  now?: () => number
}

/**
 * Bounded, in-use-aware registry of open tenant connections.
 *
 * The previous per-driver LRU evicted the oldest entry purely by last-`connect()`
 * time, with no notion of "currently serving a request". Under more than `cap`
 * concurrent distinct tenants, that could `release()` a connection whose request
 * was still in flight — severing the pool mid-query (the cross-tenant
 * data-loss symptom seen under load). This registry refuses to evict any
 * connection touched within `graceMs`: when every candidate is inside the grace
 * window it lets the pool exceed `cap` briefly and warns, which is strictly
 * safer than killing an active connection.
 */
export default class ConnectionLru {
  readonly #map = new Map<string, number>()
  // In-flight release() promises keyed by connection name. A connection being
  // evicted is deleted from #map immediately but its pool drains asynchronously;
  // until that settles, the entry is still registered (state 'closing') in
  // Lucid's manager. `connect()` must await any pending release for a name
  // before its `manager.has()` check, or it would re-adopt a closing pool.
  readonly #pendingReleases = new Map<string, Promise<void>>()
  #lastOverCapWarnAt = 0

  constructor(private readonly opts: ConnectionLruOptions) {}

  /**
   * Resolve once any in-flight release for `name` has settled. No-op when none
   * is pending. Callers await this before deciding whether the connection is
   * still registered.
   */
  async settlePending(name: string): Promise<void> {
    const pending = this.#pendingReleases.get(name)
    if (pending) await pending
  }

  #now(): number {
    return (this.opts.now ?? Date.now)()
  }

  has(name: string): boolean {
    return this.#map.has(name)
  }

  get size(): number {
    return this.#map.size
  }

  delete(name: string): void {
    this.#map.delete(name)
  }

  /** Mark `name` as most-recently-used (re-inserts to move it to the tail). */
  touch(name: string): void {
    this.#map.delete(name)
    this.#map.set(name, this.#now())
  }

  /**
   * True only when admitting a NEW connection should be refused: the hard cap is
   * enabled, the registry is at/over `cap`, and every open connection is still
   * inside the grace window (so `evictIfNeeded` could not free a slot without
   * severing an in-flight request). When a stale, evictable victim exists, or we
   * are still under cap, this returns false and the caller admits as usual.
   * Callers (the per-tenant drivers) translate `true` into a 503.
   */
  atHardLimit(): boolean {
    if (!this.opts.hardCap?.()) return false
    if (this.#map.size < this.opts.cap()) return false
    const graceMs = this.opts.graceMs()
    const now = this.#now()
    for (const [, touchedAt] of this.#map) {
      if (now - touchedAt > graceMs) return false // an evictable victim exists
    }
    return true
  }

  /**
   * Fire-and-forget: when over cap, evict the oldest connection that is NOT
   * within the in-use grace window. No-op (with a throttled warning) when
   * every connection is recently touched.
   */
  evictIfNeeded(): void {
    const cap = this.opts.cap()
    if (this.#map.size <= cap) return

    const graceMs = this.opts.graceMs()
    const now = this.#now()

    // Map preserves insertion order and `touch()` re-inserts, so the oldest
    // entries come first. Pick the first one outside the grace window.
    let victim: string | undefined
    for (const [name, touchedAt] of this.#map) {
      if (now - touchedAt > graceMs) {
        victim = name
        break
      }
    }

    if (victim === undefined) {
      // Everything is in the grace window → likely all in use. Letting the
      // pool exceed the cap for a moment beats severing an active request.
      this.#warnOverCap(cap)
      return
    }

    this.#map.delete(victim)
    const name = victim
    // Track the in-flight release so a concurrent connect() for this same name
    // awaits the pool drain instead of re-adopting the closing connection.
    // Don't swallow: a failed release leaves a pool entry registered in the
    // manager (the LRU and the manager then disagree about open connections).
    const releasing = this.opts
      .release(name)
      .catch(async (err: unknown) => {
        const logger = await lazyLogger()
        logger?.warn(
          {
            connection: name,
            err: (err as Error)?.message ?? String(err),
            owner: this.opts.label,
          },
          `${this.opts.label}: failed to release evicted connection; pool entry may linger`
        )
      })
      .finally(() => {
        // Only clear if we're still the current pending release for this name
        // (a later re-add + re-evict could have replaced it).
        if (this.#pendingReleases.get(name) === releasing) {
          this.#pendingReleases.delete(name)
        }
      })
    this.#pendingReleases.set(name, releasing)
  }

  #warnOverCap(cap: number): void {
    const now = this.#now()
    // Throttle: one warning per minute is enough to alert ops without flooding.
    if (now - this.#lastOverCapWarnAt < 60_000) return
    this.#lastOverCapWarnAt = now
    const open = this.#map.size
    const label = this.opts.label
    void lazyLogger().then((logger) =>
      logger?.warn(
        { cap, open, owner: label },
        `${label}: all ${open} connections are within the in-use grace window; ` +
          `exceeding the cap (${cap}) to avoid severing an active request. ` +
          `Raise the connection cap or scale out if this persists.`
      )
    )
  }
}
