import type { TenantModelContract } from '../types/contracts.js'

/** Default TTL for a cached tenant (ms). Also the cross-pod staleness bound. */
export const DEFAULT_RESOLUTION_CACHE_TTL_MS = 10_000

/** Default cap on simultaneously-cached tenants per process. */
export const DEFAULT_RESOLUTION_CACHE_MAX = 10_000

interface Entry {
  tenant: TenantModelContract
  expiresAt: number
}

/**
 * Bounded, TTL'd, in-process cache of resolved tenant models keyed by tenant id.
 *
 * Closes the single most expensive avoidable cost on the request hot path: the
 * `repo.findById` round-trip to the shared backoffice DB that the guard /
 * universal middleware otherwise make on EVERY request. A warm hit serves the
 * tenant with zero backoffice queries.
 *
 * Scope and guarantees:
 *   - **Per process.** Each pod keeps its own cache; there is no shared L2. This
 *     is intentional — the win is the in-process repeat-lookup, and it avoids
 *     serializing a live Lucid model across a wire.
 *   - **Bounded.** A Map is used as an LRU (insertion-order eviction on `set`,
 *     recency refresh on `get`) capped at `maxEntries`, so a huge tenant base
 *     can't grow the cache without bound.
 *   - **Fresh within `ttlMs`.** An entry past its TTL is treated as a miss.
 *     A lifecycle event (`delete`) drops an entry immediately in-process; across
 *     pods, a status change propagates within `ttlMs`.
 *   - **Read-only.** The same model instance is handed to concurrent requests,
 *     so callers must not mutate the resolved tenant (documented on the config).
 *
 * Registered as a container singleton by `MultitenancyProvider`.
 */
export default class TenantResolutionCache {
  readonly #map = new Map<string, Entry>()
  #now: () => number = Date.now

  /** Test seam: inject a deterministic clock. */
  __setClockForTests(now: () => number): void {
    this.#now = now
  }

  /** Live entry for `id`, or `undefined` on miss/expiry. Refreshes LRU recency. */
  get(id: string): TenantModelContract | undefined {
    const entry = this.#map.get(id)
    if (!entry) return undefined
    if (this.#now() >= entry.expiresAt) {
      this.#map.delete(id)
      return undefined
    }
    // Move to the tail so the least-recently-used entry stays at the head.
    this.#map.delete(id)
    this.#map.set(id, entry)
    return entry.tenant
  }

  /** Cache `tenant` under `id` for `ttlMs`, evicting the oldest over `maxEntries`. */
  set(id: string, tenant: TenantModelContract, ttlMs: number, maxEntries: number): void {
    this.#map.delete(id)
    this.#map.set(id, { tenant, expiresAt: this.#now() + ttlMs })
    while (this.#map.size > maxEntries) {
      const oldest = this.#map.keys().next().value
      if (oldest === undefined) break
      this.#map.delete(oldest)
    }
  }

  /** Drop a tenant's entry (lifecycle-event invalidation). No-op when absent. */
  delete(id: string): void {
    this.#map.delete(id)
  }

  /** Drop everything (e.g. on shutdown / config change). */
  clear(): void {
    this.#map.clear()
  }

  get size(): number {
    return this.#map.size
  }
}
