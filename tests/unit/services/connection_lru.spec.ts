import { test } from '@japa/runner'
import ConnectionLru from '../../../src/services/isolation/connection_lru.js'

/**
 * Deterministic clock + release recorder so we can assert the eviction policy
 * (the H1 fix) without a real database or wall-clock timing.
 */
function makeLru(opts: { cap?: number; graceMs?: number; failRelease?: boolean } = {}) {
  const released: string[] = []
  let clock = 1_000_000
  const lru = new ConnectionLru({
    label: 'Test',
    cap: () => opts.cap ?? 2,
    graceMs: () => opts.graceMs ?? 1000,
    release: async (name) => {
      if (opts.failRelease) throw new Error('release failed')
      released.push(name)
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
    assert.equal(lru.size, 3, 'pool is allowed to exceed the cap rather than kill an active request')
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
