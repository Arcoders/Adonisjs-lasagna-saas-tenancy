import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import { buildCacheStack } from '@adonisjs-lasagna/saas-tenancy/services'

/**
 * The deployment docs tell operators that running several pods is safe
 * because the package cache is memory L1 + shared Redis L2 with a Redis bus
 * that invalidates peer L1s. This spec proves the claim with two instances
 * built through the same `buildCacheStack` factory the package singleton
 * uses (src/utils/cache.ts), the in-process equivalent of two pods, run
 * against the suite's real Redis: a value written through instance A is
 * visible to B via L2, and a delete issued through A evicts B's
 * already-populated L1 via the bus.
 */
function buildCacheInstance() {
  return buildCacheStack({
    connection: {
      host: process.env.CACHE_REDIS_HOST ?? process.env.REDIS_HOST ?? '127.0.0.1',
      port: Number(process.env.CACHE_REDIS_PORT ?? process.env.REDIS_PORT ?? 6379),
      db: Number(process.env.CACHE_REDIS_DB ?? 2),
    },
    l1MaxSizeBytes: 1024 * 1024,
  })
}

test.group('Multi-pod cache coherency via the Redis bus (integration)', (group) => {
  let podA: ReturnType<typeof buildCacheInstance>
  let podB: ReturnType<typeof buildCacheInstance>

  // bentocache's bus subscribes fire-and-forget (the constructor never awaits
  // the ioredis SUBSCRIBE, which rides a separate connection), and Redis
  // pub/sub has no replay: a message published before B's subscription lands
  // is lost forever. A fixed sleep is therefore a race on a slow CI runner.
  // Instead, prove the path from A through the bus to B is live with probe rounds. Each round
  // publishes a FRESH delete, so a message lost during subscription startup
  // is retried, not fatal. A genuinely broken bus still fails loudly here.
  async function waitForBusReady(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const probe = `bus-ready-${randomUUID()}`
      await podA.set({ key: probe, value: 'x' })
      await podB.get({ key: probe }) // fill B's L1 with the copy to invalidate
      await podA.delete({ key: probe }) // publish the invalidation
      const roundEnd = Date.now() + 750
      while (Date.now() < roundEnd) {
        if ((await podB.get({ key: probe })) == null) return
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    throw new Error(
      `Redis bus never delivered an invalidation within ${timeoutMs}ms — bus wiring or Redis pub/sub broken`
    )
  }

  group.setup(async () => {
    podA = buildCacheInstance()
    podB = buildCacheInstance()
    await waitForBusReady()
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
