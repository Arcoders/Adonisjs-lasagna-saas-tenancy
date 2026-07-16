import { test } from '@japa/runner'
import {
  findTenantByIdCached,
  __setResolutionCacheForTests,
  __resetResolutionCacheRefForTests,
} from '../../../../src/extensions/request.js'
import TenantResolutionCache from '../../../../src/services/tenant_resolution_cache.js'
import { setupTestConfig } from '../../../helpers/config.js'
import type {
  TenantModelContract,
  TenantRepositoryContract,
} from '../../../../src/types/contracts.js'

/**
 * A repository double that counts how many times `findById` actually hits "the
 * database". This is the deterministic stand-in for a query-count assertion: the
 * P1-1 cache must turn the second warm lookup into ZERO repo calls.
 */
function countingRepo() {
  let calls = 0
  const repo = {
    async findById(id: string): Promise<TenantModelContract | null> {
      calls += 1
      return { id } as unknown as TenantModelContract
    },
  } as unknown as TenantRepositoryContract
  return { repo, calls: () => calls }
}

test.group('findTenantByIdCached — query-count guard (P1-1)', (group) => {
  group.each.teardown(() => __resetResolutionCacheRefForTests())

  test('cache disabled: every request hits the registry (unchanged behaviour)', async ({
    assert,
  }) => {
    setupTestConfig()
    const { repo, calls } = countingRepo()
    await findTenantByIdCached(repo, 'tenant-1')
    await findTenantByIdCached(repo, 'tenant-1')
    assert.equal(calls(), 2)
  })

  test('cache enabled: the warm second lookup makes ZERO backoffice queries', async ({
    assert,
  }) => {
    setupTestConfig({ resolver: { cache: { enabled: true, ttlMs: 10_000 } } })
    __setResolutionCacheForTests(new TenantResolutionCache())

    const { repo, calls } = countingRepo()
    const first = await findTenantByIdCached(repo, 'tenant-1')
    const second = await findTenantByIdCached(repo, 'tenant-1')

    // The regression guard: a lost cache would make this 2.
    assert.equal(calls(), 1)
    assert.equal(first?.id, 'tenant-1')
    assert.strictEqual(first, second)
  })

  test('cache enabled: a lifecycle-event invalidation forces a re-fetch', async ({ assert }) => {
    setupTestConfig({ resolver: { cache: { enabled: true, ttlMs: 10_000 } } })
    const cache = new TenantResolutionCache()
    __setResolutionCacheForTests(cache)

    const { repo, calls } = countingRepo()
    await findTenantByIdCached(repo, 'tenant-1')
    cache.delete('tenant-1') // what the provider's event listener does on suspend
    await findTenantByIdCached(repo, 'tenant-1')

    assert.equal(calls(), 2)
  })
})
