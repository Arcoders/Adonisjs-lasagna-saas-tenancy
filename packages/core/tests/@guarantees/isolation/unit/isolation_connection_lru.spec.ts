import { test } from '@japa/runner'
import ConnectionLru from '../../../../src/services/isolation/connection_lru.js'

/**
 * Deterministic clock + release recorder so we can assert the eviction policy
 * (the H1 fix) without a real database or wall-clock timing.
 */
function makeLru(
  opts: {
    cap?: number
    graceMs?: number
    failRelease?: boolean
    declineRelease?: boolean
    hardCap?: boolean
    hardCeiling?: number
  } = {}
) {
  const released: string[] = []
  let clock = 1_000_000
  const lru = new ConnectionLru({
    label: 'Test',
    cap: () => opts.cap ?? 2,
    graceMs: () => opts.graceMs ?? 1000,
    hardCap: () => opts.hardCap ?? false,
    hardCeiling: () => opts.hardCeiling,
    release: async (name) => {
      if (opts.failRelease) throw new Error('release failed')
      // Simulate a connection with a query still in flight: the driver declines.
      if (opts.declineRelease) return false
      released.push(name)
      return true
    },
    now: () => clock,
  })
  return {
    lru,
    released,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

test.group('ConnectionLru — in-use-aware eviction', () => {
  test('does not evict while at or under the cap', ({ assert }) => {
    const { lru, released } = makeLru({ cap: 2 })
    lru.touch('a')
    lru.touch('b')
    lru.evictIfNeeded()
    assert.deepEqual(released, [])
    assert.equal(lru.size, 2)
  })

  test('evicts the oldest connection that is outside the grace window', ({ assert }) => {
    const { lru, released, advance } = makeLru({ cap: 2, graceMs: 1000 })
    lru.touch('a') // oldest
    advance(5000) // 'a' is now idle (5000ms > 1000ms grace)
    lru.touch('b')
    lru.touch('c')
    lru.evictIfNeeded()
    assert.deepEqual(released, ['a'])
    assert.isFalse(lru.has('a'))
    assert.equal(lru.size, 2)
  })

  test('never severs an in-use connection: exceeds the cap when all are within grace', ({
    assert,
  }) => {
    const { lru, released } = makeLru({ cap: 2, graceMs: 1000 })
    lru.touch('a')
    lru.touch('b')
    lru.touch('c') // 3 > cap, but all just touched → all in-use
    lru.evictIfNeeded()
    assert.deepEqual(released, [], 'no connection released while all are within the grace window')
    assert.equal(
      lru.size,
      3,
      'pool is allowed to exceed the cap rather than kill an active request'
    )
    assert.isTrue(lru.has('a'))
  })

  test('re-touching moves a connection out of the eviction line', ({ assert }) => {
    const { lru, released, advance } = makeLru({ cap: 2, graceMs: 1000 })
    lru.touch('a')
    advance(2000)
    lru.touch('b')
    advance(2000)
    lru.touch('a') // 'a' refreshed → now newest; 'b' is the oldest idle
    lru.touch('c')
    lru.evictIfNeeded()
    assert.deepEqual(released, ['b'])
    assert.isTrue(lru.has('a'))
  })

  // SECURITY/availability (#15): a stale connection that still has a query in
  // flight must not be severed. The driver's release declines (returns false),
  // and the LRU keeps the connection tracked with a fresh heartbeat.
  test('keeps a stale-but-busy connection when release declines', async ({ assert }) => {
    const { lru, released, advance } = makeLru({ cap: 2, graceMs: 1000, declineRelease: true })
    lru.touch('a')
    advance(5000) // 'a' is past the grace window: a candidate for eviction...
    lru.touch('b')
    lru.touch('c') // over cap, so 'a' gets picked
    lru.evictIfNeeded()

    await lru.settlePending('a')
    assert.deepEqual(released, [], 'a busy connection is never closed')
    assert.isTrue(lru.has('a'), 'it stays tracked after the decline')
  })

  test('a declined connection gets a fresh heartbeat so it is not picked again next cycle', async ({
    assert,
  }) => {
    const { lru, advance } = makeLru({ cap: 1, graceMs: 1000, declineRelease: true })
    lru.touch('a')
    advance(5000)
    lru.touch('b') // over cap → 'a' is the stale victim
    lru.evictIfNeeded()
    await lru.settlePending('a')
    // 'a' was re-stamped at "now", so it is now the freshest, not the oldest.
    assert.isTrue(lru.has('a'))
  })

  test('delete drops a connection from tracking', ({ assert }) => {
    const { lru } = makeLru({ cap: 5 })
    lru.touch('a')
    assert.isTrue(lru.has('a'))
    lru.delete('a')
    assert.isFalse(lru.has('a'))
    assert.equal(lru.size, 0)
  })

  test('a failing release does not throw and still drops the entry from tracking', ({ assert }) => {
    const { lru, advance } = makeLru({ cap: 1, graceMs: 1000, failRelease: true })
    lru.touch('a')
    advance(5000)
    lru.touch('b')
    assert.doesNotThrow(() => lru.evictIfNeeded())
    // The victim is removed from the LRU even though the underlying release
    // rejected (the rejection is logged, not propagated).
    assert.isFalse(lru.has('a'))
  })
})

test.group('ConnectionLru — hard cap admission (enforceConnectionCap)', () => {
  test('never at the hard limit when hardCap is off, even over cap', ({ assert }) => {
    const { lru } = makeLru({ cap: 2, hardCap: false })
    lru.touch('a')
    lru.touch('b')
    lru.touch('c') // over cap, but hardCap off → legacy exceed-the-cap behavior
    assert.isFalse(lru.atHardLimit())
  })

  test('not at the hard limit while under the cap', ({ assert }) => {
    const { lru } = makeLru({ cap: 2, hardCap: true })
    lru.touch('a')
    assert.isFalse(lru.atHardLimit())
  })

  test('at the hard limit when at cap and every connection is within grace', ({ assert }) => {
    const { lru } = makeLru({ cap: 2, graceMs: 1000, hardCap: true })
    lru.touch('a')
    lru.touch('b') // at cap, both just touched → nothing evictable
    assert.isTrue(lru.atHardLimit())
  })

  test('not at the hard limit when an evictable (idle) victim exists', ({ assert }) => {
    const { lru, advance } = makeLru({ cap: 2, graceMs: 1000, hardCap: true })
    lru.touch('a')
    advance(5000) // 'a' aged past the grace window → evictable
    lru.touch('b')
    assert.isFalse(lru.atHardLimit(), 'a stale victim can be evicted to make room')
  })
})

test.group('ConnectionLru — absolute hard ceiling (F1)', () => {
  test('no ceiling configured: never at the ceiling, even far over cap', ({ assert }) => {
    const { lru } = makeLru({ cap: 2 }) // hardCeiling undefined
    for (const n of ['a', 'b', 'c', 'd', 'e']) lru.touch(n)
    assert.isFalse(lru.atHardCeiling())
  })

  test('below the ceiling: admission is allowed', ({ assert }) => {
    const { lru } = makeLru({ cap: 2, hardCeiling: 4 })
    lru.touch('a')
    lru.touch('b')
    lru.touch('c') // 3 < ceiling 4
    assert.isFalse(lru.atHardCeiling())
  })

  test('at/above the ceiling: refused ALWAYS, regardless of hardCap (soft cap off)', ({
    assert,
  }) => {
    // hardCap is OFF (availability-favouring), yet the absolute ceiling still bites.
    const { lru } = makeLru({ cap: 10, hardCap: false, hardCeiling: 3 })
    lru.touch('a')
    lru.touch('b')
    lru.touch('c') // size == ceiling
    assert.isTrue(
      lru.atHardCeiling(),
      'the absolute ceiling holds even with enforceConnectionCap off'
    )
    assert.isFalse(lru.atHardLimit(), 'the soft cap does not bite (hardCap off, under cap)')
  })

  test('yields to an idle victim (no lockup); refuses only when all are in-use', ({ assert }) => {
    // Like the soft cap, the ceiling sheds an idle connection to make room rather
    // than lock the pool. It refuses only when every connection at the ceiling is
    // still in use (evictIfNeeded could not free a slot).
    const { lru, advance } = makeLru({ cap: 10, hardCap: false, graceMs: 1000, hardCeiling: 2 })
    lru.touch('a')
    advance(5000) // 'a' is idle/evictable
    lru.touch('b') // size == ceiling, but 'a' is a reclaimable victim
    assert.isFalse(
      lru.atHardCeiling(),
      'an idle connection can be evicted to admit a new one — the ceiling never locks the pool'
    )

    lru.touch('a') // now BOTH are within grace → nothing evictable
    assert.isTrue(lru.atHardCeiling(), 'refuses only when the pool is full of ACTIVE connections')
  })
})
