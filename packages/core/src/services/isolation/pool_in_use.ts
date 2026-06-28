/**
 * Best-effort "is a query in flight on this connection right now?" check.
 *
 * It reads the checked-out count from the underlying knex/tarn pool. A query
 * holds its connection checked out for its whole duration, so `numUsed() > 0`
 * means there is live work we must not sever.
 *
 * The lookup walks Lucid + knex internals, so it is wrapped to never throw. When
 * the count can't be read (internals moved between versions, or the pool hasn't
 * been built yet), it returns `false`. That makes eviction fall back to the old
 * grace-window behaviour instead of crashing or pinning the pool open forever.
 * A leaked-open pool is worse than the rare severed long query the grace window
 * already mostly covers, so "unknown" maps to "evictable".
 */
export function connectionHasActiveQuery(manager: unknown, name: string): boolean {
  try {
    const node = (manager as { get?: (n: string) => unknown })?.get?.(name)
    const pool = (node as any)?.connection?.client?.client?.pool
    if (!pool || typeof pool.numUsed !== 'function') return false
    return pool.numUsed() > 0
  } catch {
    return false
  }
}
