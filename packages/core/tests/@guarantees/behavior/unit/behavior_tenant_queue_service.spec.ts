import { test } from '@japa/runner'
import type { Queue, QueueOptions } from 'bullmq'
import TenantQueueService from '../../../../src/services/tenant_queue_service.js'
import { setupTestConfig } from '../../../helpers/config.js'

/**
 * A stub that stands in for a BullMQ `Queue` so the handle-eviction logic can
 * be exercised without a live ioredis connection. Only the surface the LRU
 * touches (`close`) is implemented.
 */
class FakeQueue {
  closed = false
  constructor(public readonly name: string) {}
  async close(): Promise<void> {
    this.closed = true
  }
}

/**
 * Test double that swaps the real BullMQ `Queue` for {@link FakeQueue} and
 * records every handle it ever created so we can assert how many were closed.
 */
class StubbedQueueService extends TenantQueueService {
  readonly created: FakeQueue[] = []
  #clock = 0
  // Strictly-increasing deterministic clock so the idle-grace eviction doesn't
  // depend on Date.now() advancing within a tight synchronous loop.
  protected override now(): number {
    this.#clock += 1
    return this.#clock
  }
  protected override createQueue(name: string, _options: QueueOptions): Queue {
    const q = new FakeQueue(name)
    this.created.push(q)
    return q as unknown as Queue
  }
}

test.group('TenantQueueService — handle bound (P1-3)', (group) => {
  group.each.setup(() => {
    setupTestConfig({
      queue: {
        tenantQueuePrefix: 'tq_',
        defaultConcurrency: 1,
        attempts: 3,
        redis: { host: '127.0.0.1', port: 6379, db: 1 },
        maxOpenQueues: 5,
        // Zero grace so every previously-touched handle is immediately
        // evictable. The LRU keeps the live set at the cap as we churn.
        queueIdleGraceMs: 0,
      },
    })
  })

  test('caps the number of simultaneously-open queue handles', async ({ assert }) => {
    const svc = new StubbedQueueService()

    // Dispatch to far more distinct tenants than the cap. Without the LRU this
    // map would grow to 50; with it, idle handles are reclaimed down to the cap.
    for (let i = 0; i < 50; i++) {
      svc.getOrCreate(`tenant-${i}`)
    }
    // Let the fire-and-forget releases settle.
    await new Promise((r) => setImmediate(r))

    assert.isAtMost(svc.openHandleCount, 5)
    // The reclaimed handles were actually closed, not just dropped.
    const closed = svc.created.filter((q) => q.closed).length
    assert.isAtLeast(closed, 50 - 5)
  })

  test('reuses the existing handle for a repeat tenant (no new connection)', ({ assert }) => {
    const svc = new StubbedQueueService()
    const first = svc.getOrCreate('tenant-a')
    const second = svc.getOrCreate('tenant-a')
    assert.strictEqual(first, second)
    assert.equal(svc.created.length, 1)
  })
})
