import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import { BentoCache, bentostore } from 'bentocache'
import { memoryDriver } from 'bentocache/drivers/memory'
import { redisDriver, redisBusDriver } from 'bentocache/drivers/redis'

/**
 * The deployment docs tell operators that running several pods is safe
 * because the package cache is memory L1 + shared Redis L2 with a Redis bus
 * that invalidates peer L1s (src/utils/cache.ts builds exactly that store).
 * This spec proves the claim with two independent BentoCache instances —
 * the in-process equivalent of two pods — against the suite's real Redis:
 * a value written through instance A is visible to B via L2, and a delete
 * issued through A evicts B's already-populated L1 via the bus.
 */
function buildCacheInstance() {
  const connection = {
    host: process.env.CACHE_REDIS_HOST ?? process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.CACHE_REDIS_PORT ?? process.env.REDIS_PORT ?? 6379),
    db: Number(process.env.CACHE_REDIS_DB ?? 2),
  }
  return new BentoCache({
    default: 'cache',
    stores: {
      cache: bentostore()
        .useL1Layer(memoryDriver({ maxSize: 1024 * 1024 }))
        .useL2Layer(redisDriver({ connection }))
        .useBus(redisBusDriver({ connection })),
    },
  })
}

test.group('Multi-pod cache coherency via the Redis bus (integration)', (group) => {
  let podA: ReturnType<typeof buildCacheInstance>
  let podB: ReturnType<typeof buildCacheInstance>

  group.setup(async () => {
    podA = buildCacheInstance()
    podB = buildCacheInstance()
    // Give both bus subscriptions a beat to come up before the first publish.
    await new Promise((r) => setTimeout(r, 300))
  })

  group.teardown(async () => {
    await podA?.disconnectAll().catch(() => {})
    await podB?.disconnectAll().catch(() => {})
  })

  test('a value set on pod A is readable from pod B through the shared L2', async ({ assert }) => {
    const key = `coherency-l2-${randomUUID()}`
    await podA.set({ key, value: 'from-pod-a' })
    assert.equal(await podB.get({ key }), 'from-pod-a')
  })

  test("a delete on pod A evicts pod B's already-populated L1 via the bus", async ({ assert }) => {
    const key = `coherency-bus-${randomUUID()}`
    await podA.set({ key, value: 'v1' })

    // Two reads on B: the first fills B's L1 from L2, the second proves the
    // L1 is serving (same value, no error). This is the stale copy the bus
    // must invalidate.
    assert.equal(await podB.get({ key }), 'v1')
    assert.equal(await podB.get({ key }), 'v1')

    await podA.delete({ key })

    // Bus delivery is async; poll instead of sleeping a fixed amount.
    const deadline = Date.now() + 5000
    let observed: unknown = 'v1'
    while (Date.now() < deadline) {
      observed = await podB.get({ key })
      if (observed === undefined || observed === null) break
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.isTrue(
      observed === undefined || observed === null,
      `pod B still serves "${String(observed)}" 5s after pod A deleted the key`
    )
  })
})
