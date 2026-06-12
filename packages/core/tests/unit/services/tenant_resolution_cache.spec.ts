import { test } from '@japa/runner'
import TenantResolutionCache from '../../../src/services/tenant_resolution_cache.js'
import type { TenantModelContract } from '../../../src/types/contracts.js'

function fakeTenant(id: string): TenantModelContract {
  return { id } as unknown as TenantModelContract
}

test.group('TenantResolutionCache (P1-1)', () => {
  test('returns a cached tenant within its TTL', ({ assert }) => {
    const cache = new TenantResolutionCache()
    let now = 1_000
    cache.__setClockForTests(() => now)

    cache.set('a', fakeTenant('a'), 10_000, 100)
    now = 5_000
    assert.equal(cache.get('a')?.id, 'a')
  })

  test('treats an expired entry as a miss', ({ assert }) => {
    const cache = new TenantResolutionCache()
    let now = 1_000
    cache.__setClockForTests(() => now)

    cache.set('a', fakeTenant('a'), 10_000, 100)
    now = 11_001
    assert.isUndefined(cache.get('a'))
    assert.equal(cache.size, 0)
  })

  test('delete drops an entry immediately (event invalidation)', ({ assert }) => {
    const cache = new TenantResolutionCache()
    cache.set('a', fakeTenant('a'), 10_000, 100)
    cache.delete('a')
    assert.isUndefined(cache.get('a'))
  })

  test('evicts the least-recently-used entry over the cap', ({ assert }) => {
    const cache = new TenantResolutionCache()
    cache.set('a', fakeTenant('a'), 10_000, 2)
    cache.set('b', fakeTenant('b'), 10_000, 2)
    // Touch 'a' so 'b' becomes the LRU victim.
    assert.equal(cache.get('a')?.id, 'a')
    cache.set('c', fakeTenant('c'), 10_000, 2)

    assert.equal(cache.size, 2)
    assert.isUndefined(cache.get('b'))
    assert.equal(cache.get('a')?.id, 'a')
    assert.equal(cache.get('c')?.id, 'c')
  })
})
