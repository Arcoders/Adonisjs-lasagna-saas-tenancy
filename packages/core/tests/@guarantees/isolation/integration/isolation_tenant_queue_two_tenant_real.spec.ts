import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import { Worker } from 'bullmq'
import { TenantQueueService } from '@adonisjs-lasagna/saas-tenancy/services'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy'

/**
 * ISOLATION — per-tenant queue isolation against REAL BullMQ + Redis. The scheduler
 * fan-out is proven elsewhere with a `RecordingScheduler` double (no Redis), which
 * captures the dispatch call but can NOT prove the load-bearing property: that each
 * tenant's job lands in that tenant's OWN queue and a worker draining tenant A never
 * observes tenant B's job. This drives the real `TenantQueueService` (real
 * `new Queue(...)` per tenant, keyed `${tenantQueuePrefix}${tenantId}`) + a real
 * BullMQ `Worker`, so the isolation is proven end to end, not against a fake.
 */
test.group('tenant queue isolation — real BullMQ (integration)', (group) => {
  const svc = new TenantQueueService()
  const tenantA = randomUUID()
  const tenantB = randomUUID()

  group.teardown(async () => {
    await svc.destroy(tenantA).catch(() => {})
    await svc.destroy(tenantB).catch(() => {})
  })

  test('a worker draining tenant A never observes tenant B’s job (separate queues)', async ({
    assert,
  }) => {
    const queueA = svc.getOrCreate(tenantA)
    const queueB = svc.getOrCreate(tenantB)

    // Structural isolation: the two tenants resolve to physically distinct queues.
    assert.equal(queueA.name, `${getConfig().queue.tenantQueuePrefix}${tenantA}`)
    assert.equal(queueB.name, `${getConfig().queue.tenantQueuePrefix}${tenantB}`)
    assert.notEqual(queueA.name, queueB.name)

    // Start empty (a previous run of these UUIDs is impossible, but be defensive).
    await queueA.drain(true).catch(() => {})
    await queueB.drain(true).catch(() => {})

    // Enqueue one job into EACH tenant's queue with a tenant-tagged payload.
    await queueA.add('probe', { owner: 'A' })
    const jobB = await queueB.add('probe', { owner: 'B' })

    const conn = getConfig().queue.redis
    const processed: string[] = []
    // A worker bound ONLY to tenant A's queue name.
    const worker = new Worker(
      queueA.name,
      async (job) => {
        processed.push(job.data.owner as string)
      },
      {
        connection: {
          host: conn.host,
          port: conn.port,
          username: conn.username ?? undefined,
          password: conn.password ?? undefined,
          db: conn.db ?? 0,
        },
      }
    )

    try {
      // Wait until A's job has been processed.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('tenant A job not processed within 15s')),
          15_000
        )
        worker.on('completed', () => {
          clearTimeout(timer)
          resolve()
        })
      })

      // The worker saw ONLY tenant A's job — never tenant B's.
      assert.deepEqual(processed, ['A'], 'the tenant-A worker processed only tenant A’s job')

      // Tenant B's job is untouched: it still sits in tenant B's queue.
      const stillWaitingB = await queueB.getJob(jobB.id!)
      assert.isNotNull(stillWaitingB, 'tenant B’s job was not consumed by tenant A’s worker')
      const finished = await stillWaitingB!.isCompleted()
      assert.isFalse(finished, 'tenant B’s job remains unprocessed in its own queue')
    } finally {
      await worker.close()
    }
  }).timeout(20_000)
})
