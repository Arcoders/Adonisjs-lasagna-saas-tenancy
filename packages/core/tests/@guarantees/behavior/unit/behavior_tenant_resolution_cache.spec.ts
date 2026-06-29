import { test } from '@japa/runner'
import TenantResolutionCache from '../../../../src/services/tenant_resolution_cache.js'
import type { TenantModelContract } from '../../../../src/types/contracts.js'

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

  // Pins the sharing contract (P2-2): the cache hands the SAME instance to
  // every concurrent request — it does not snapshot or freeze. This is exactly
  // why the config doc says "treat the resolved tenant as READ-ONLY; load a
  // fresh instance to mutate". If this test starts failing because get()
  // returns a copy, the documented contract changed: update the config JSDoc
  // and performance.md in the same change.
  test('get returns the same shared instance — a mutation is visible to other readers', ({
    assert,
  }) => {
    const cache = new TenantResolutionCache()
    const tenant = fakeTenant('a') as TenantModelContract & { name?: string }
    cache.set('a', tenant, 10_000, 100)

    const requestOne = cache.get('a') as typeof tenant
    const requestTwo = cache.get('a') as typeof tenant
    assert.strictEqual(requestOne, tenant)
    assert.strictEqual(requestTwo, tenant)

    requestOne.name = 'mutated-by-request-one'
    assert.equal(
      (cache.get('a') as typeof tenant).name,
      'mutated-by-request-one',
      'a mutation through one reader bleeds into every other reader — the reason the contract is read-only'
    )
  })
})
