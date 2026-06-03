import { runMicro, type BenchResult } from '../harness/runner.js'
import { ConnectionLru } from './internal.js'

const GROUP = 'connection_lru'

/**
 * Prices the in-use-aware connection LRU that every schema-pg/database-pg
 * `connect()` touches. Uses an injected clock + a no-op release counter so the
 * over-cap eviction branch is exercised deterministically.
 */
export function runConnectionLru(): BenchResult[] {
  // Case A: touch an already-present key (the warm reuse path).
  const hot = new ConnectionLru({
    label: 'bench',
    cap: () => 1000,
    graceMs: () => 30_000,
    release: async () => {},
    now: () => 1,
  })
  hot.touch('warm')

  // Case B: round-robin touch over a fixed working set (MRU churn, no evict).
  const ring = new ConnectionLru({
    label: 'bench',
    cap: () => 1000,
    graceMs: () => 30_000,
    release: async () => {},
    now: () => 1,
  })
  for (let i = 0; i < 50; i++) ring.touch(`k${i}`)
  let ringIdx = 0

  // Case C: insert past the cap with the clock advanced beyond the grace
  // window, so every step evicts the oldest victim (the churn hot path).
  let clock = 0
  let seq = 0
  const churn = new ConnectionLru({
    label: 'bench',
    cap: () => 50,
    graceMs: () => 30_000,
    release: async () => {},
    now: () => clock,
  })

  // Case D: evictIfNeeded early-return when under cap (the common no-op).
  const underCap = new ConnectionLru({
    label: 'bench',
    cap: () => 1000,
    graceMs: () => 30_000,
    release: async () => {},
    now: () => 1,
  })
  for (let i = 0; i < 10; i++) underCap.touch(`u${i}`)

  return [
    runMicro('touch (hit)', () => hot.touch('warm'), { group: GROUP }),
    runMicro('touch (MRU round-robin)', () => ring.touch(`k${ringIdx++ % 50}`), { group: GROUP }),
    runMicro(
      'touch + evictIfNeeded (over cap, evicts)',
      () => {
        clock += 30_001
        churn.touch(`t${seq++}`)
        churn.evictIfNeeded()
      },
      { group: GROUP }
    ),
    runMicro('evictIfNeeded (under cap, no-op)', () => underCap.evictIfNeeded(), { group: GROUP }),
  ]
}
