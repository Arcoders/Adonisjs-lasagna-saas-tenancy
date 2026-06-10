import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import { Worker } from 'bullmq'
import { TenantQueueService } from '@adonisjs-lasagna/saas-tenancy/services'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy'

/**
 * jobs.md promises "the queue retries per the configured `attempts`". This
 * pins the wiring (BullMQ defaultJobOptions.attempts comes from
 * config.queue.attempts) AND the behavior: a job whose processor always
 * throws is attempted exactly `attempts` times before landing in the
 * failed set.
 */
test.group('TenantQueueService — retry attempts wiring (integration)', (group) => {
  const svc = new TenantQueueService()
  const tenantId = randomUUID()

  group.teardown(async () => {
    await svc.destroy(tenantId)
  })

  test('getOrCreate wires defaultJobOptions.attempts from config.queue.attempts', async ({
    assert,
  }) => {
    const queue = svc.getOrCreate(tenantId)
    assert.equal(queue.defaultJobOptions?.attempts, getConfig().queue.attempts)
    assert.equal(queue.name, `${getConfig().queue.tenantQueuePrefix}${tenantId}`)
    assert.strictEqual(svc.getOrCreate(tenantId), queue, 'per-tenant instance is cached')
  })

  test('a failing job is retried exactly `attempts` times, then lands in the failed set', async ({
    assert,
  }) => {
    const attempts = 3
    const queue = svc.getOrCreate(tenantId)
    const conn = getConfig().queue.redis

    let executions = 0
    const worker = new Worker(
      queue.name,
      async () => {
        executions += 1
        throw new Error('always failing — retry probe')
      },
      {
        connection: {
          host: conn.host,
          port: conn.port,
          username: conn.username ?? undefined,
          password: conn.password ?? undefined,
          db: conn.db ?? 0,
        },
        // No backoff configured on the job → BullMQ retries immediately,
        // keeping the spec fast.
      }
    )

    try {
      const job = await queue.add('retry-probe', { ping: true }, { attempts })

      const failedFinally = await new Promise<{ attemptsMade: number }>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('job did not exhaust retries within 15s')),
          15_000
        )
        worker.on('failed', (j) => {
          if (j?.id !== job.id) return
          // Intermediate failures keep the job retryable; only resolve when
          // BullMQ has burned the last attempt.
          if ((j.attemptsMade ?? 0) >= attempts) {
            clearTimeout(timer)
            resolve({ attemptsMade: j.attemptsMade })
          }
        })
      })

      assert.equal(failedFinally.attemptsMade, attempts)
      assert.equal(executions, attempts, 'the processor must run once per attempt')

      const failedJobs = await queue.getFailed()
      assert.isTrue(
        failedJobs.some((f) => f.id === job.id),
        'the exhausted job must sit in the failed set'
      )
    } finally {
      await worker.close()
    }
  }).timeout(20_000)
})
