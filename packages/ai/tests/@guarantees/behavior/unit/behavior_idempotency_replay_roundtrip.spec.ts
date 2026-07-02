import { test } from '@japa/runner'
import AiIdempotencyService, {
  deriveAiIdempotencyMacKey,
  type AiIdempotencyScope,
  type AiIdempotencyStore,
  type CachedAiResponse,
} from '../../../../src/gateway/idempotency.js'

/**
 * The replay round trip against a Map-backed store double: save-then-lookup
 * returns the exact frames, the epoch bump invalidates, and every store
 * failure degrades to "no replay" (fail-open), except the epoch-unreadable
 * privacy edge which also yields no replay.
 */

interface FakeEntry {
  value: string
  ttlMs: number
}

function fakeStore() {
  const data = new Map<string, FakeEntry>()
  let failGet = false
  let failSet = false
  let failEpochOnly = false
  const store: AiIdempotencyStore = {
    async get(tenantId, key) {
      if (failGet) throw new Error('redis down')
      if (failEpochOnly && key === 'ai:idem:epoch') throw new Error('redis flaky')
      return data.get(`${tenantId}|${key}`)?.value
    },
    async set(tenantId, key, value, ttlMs) {
      if (failSet) throw new Error('redis down')
      data.set(`${tenantId}|${key}`, { value, ttlMs })
    },
  }
  return {
    store,
    data,
    setFailGet: (v: boolean) => (failGet = v),
    setFailSet: (v: boolean) => (failSet = v),
    setFailEpochOnly: (v: boolean) => (failEpochOnly = v),
  }
}

function makeService(store: AiIdempotencyStore, overrides: { maxBytes?: number } = {}) {
  return new AiIdempotencyService({
    store,
    macKey: deriveAiIdempotencyMacKey('app-key-under-test'),
    ttlMs: 60_000,
    maxBytes: overrides.maxBytes,
  })
}

const scope: AiIdempotencyScope = {
  tenantId: 'tenant-a',
  principal: 'user-1',
  sessionId: 's1',
  headerKey: 'retry-1',
}

const completed: CachedAiResponse = {
  v: 1,
  frames: ['id: 1\nevent: token\ndata: hola\n\n', 'id: 2\nevent: token\ndata: mundo\n\n'],
  result: { tokensSettled: 7, fragments: 2, lastEventId: '2' },
}

test.group('idempotency replay round trip', () => {
  test('save then lookup returns the exact frames and result', async ({ assert }) => {
    const { store } = fakeStore()
    const svc = makeService(store)

    await svc.save(scope, completed)
    const replay = await svc.lookup(scope)

    assert.deepEqual(replay, completed)
  })

  test('a different scope misses', async ({ assert }) => {
    const { store } = fakeStore()
    const svc = makeService(store)
    await svc.save(scope, completed)

    assert.isNull(await svc.lookup({ ...scope, principal: 'user-2' }))
    assert.isNull(await svc.lookup({ ...scope, headerKey: 'retry-2' }))
  })

  test('bumping the epoch makes every prior entry unreachable', async ({ assert }) => {
    const { store } = fakeStore()
    const svc = makeService(store)
    await svc.save(scope, completed)
    assert.deepEqual(await svc.lookup(scope), completed)

    await svc.bumpEpoch(scope.tenantId)

    assert.isNull(await svc.lookup(scope), 'post-bump lookups must miss')
    await svc.save(scope, completed)
    assert.deepEqual(await svc.lookup(scope), completed, 'the new epoch works normally')
  })

  test('the epoch bump is per tenant', async ({ assert }) => {
    const { store } = fakeStore()
    const svc = makeService(store)
    const otherTenant: AiIdempotencyScope = { ...scope, tenantId: 'tenant-b' }
    await svc.save(scope, completed)
    await svc.save(otherTenant, completed)

    await svc.bumpEpoch(scope.tenantId)

    assert.isNull(await svc.lookup(scope))
    assert.deepEqual(await svc.lookup(otherTenant), completed, 'other tenants keep their cache')
  })

  test('a store read failure degrades to no replay, never a throw', async ({ assert }) => {
    const fake = fakeStore()
    const svc = makeService(fake.store)
    await svc.save(scope, completed)

    fake.setFailGet(true)
    assert.isNull(await svc.lookup(scope))
  })

  test('a store write failure never fails the save call', async ({ assert }) => {
    const fake = fakeStore()
    const svc = makeService(fake.store)
    fake.setFailSet(true)

    await svc.save(scope, completed)
    fake.setFailSet(false)
    assert.isNull(await svc.lookup(scope), 'nothing was persisted, and nothing threw')
  })

  test('an unreadable epoch yields no replay AND no save (the privacy direction)', async ({
    assert,
  }) => {
    const fake = fakeStore()
    const svc = makeService(fake.store)
    await svc.save(scope, completed)

    fake.setFailEpochOnly(true)
    assert.isNull(await svc.lookup(scope), 'cannot confirm the epoch, so no replay')

    await svc.save(scope, completed)
    assert.equal(
      [...fake.data.keys()].filter((k) => !k.endsWith('ai:idem:epoch')).length,
      1,
      'no second entry lands while the epoch is unreadable'
    )
  })

  test('an oversized response is simply not cached', async ({ assert }) => {
    const { store, data } = fakeStore()
    const svc = makeService(store, { maxBytes: 64 })

    await svc.save(scope, completed)
    assert.equal(data.size, 0, 'over the byte cap, the save is a no-op')
  })

  test('corrupt or foreign-shaped entries are misses, never throws', async ({ assert }) => {
    const fake = fakeStore()
    const svc = makeService(fake.store)
    const key = svc.entryKey(scope, '0')

    for (const raw of [
      'not json',
      '"a string"',
      '{}',
      JSON.stringify({ v: 2, frames: [], result: { tokensSettled: 0, fragments: 0 } }),
      JSON.stringify({ v: 1, frames: [1], result: { tokensSettled: 0, fragments: 0 } }),
      JSON.stringify({ v: 1, frames: [] }),
      JSON.stringify({ v: 1, frames: [], result: { tokensSettled: 'x', fragments: 0 } }),
    ]) {
      fake.data.set(`${scope.tenantId}|${key}`, { value: raw, ttlMs: 60_000 })
      assert.isNull(await svc.lookup(scope), `should miss on: ${raw}`)
    }
  })

  test('entries are written with the configured TTL and the epoch outlives them', async ({
    assert,
  }) => {
    const fake = fakeStore()
    const svc = makeService(fake.store)
    await svc.save(scope, completed)
    await svc.bumpEpoch(scope.tenantId)

    const entryTtls = [...fake.data.entries()]
      .filter(([k]) => !k.endsWith('ai:idem:epoch'))
      .map(([, v]) => v.ttlMs)
    const epochTtl = fake.data.get(`${scope.tenantId}|ai:idem:epoch`)?.ttlMs
    assert.deepEqual(entryTtls, [60_000])
    assert.isAtLeast(epochTtl!, 24 * 60 * 60 * 1000)
  })
})
