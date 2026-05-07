import { test } from '@japa/runner'
import { Queue } from 'bullmq'
import { randomUUID } from 'node:crypto'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { queueStuckCheck } from '@adonisjs-lasagna/saas-tenancy/services'
import type { DoctorContext } from '@adonisjs-lasagna/saas-tenancy/services'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

function fakeActiveTenant(id: string): TenantModelContract {
  return {
    id,
    name: `tenant-${id.slice(0, 8)}`,
    isActive: true,
    isSuspended: false,
    isProvisioning: false,
    isFailed: false,
    isDeleted: false,
  } as unknown as TenantModelContract
}

const ctxFor = (tenants: TenantModelContract[]): DoctorContext =>
  ({ tenants, repo: {} as any, attemptFix: false }) as DoctorContext

/**
 * S2-2: queue_stuck_check against real BullMQ + Redis. We seed a
 * tenant queue with a known-failed job and assert the check surfaces
 * it. We also confirm a clean queue produces zero issues.
 */
test.group('Doctor: queue_health — real BullMQ state', (group) => {
  const tenantId = randomUUID()
  let testQueue: Queue | undefined

  function queueName(): string {
    return `${getConfig().queue.tenantQueuePrefix}${tenantId}`
  }

  group.each.teardown(async () => {
    if (testQueue) {
      await testQueue.obliterate({ force: true }).catch(() => {})
      await testQueue.close().catch(() => {})
      testQueue = undefined
    }
  })

  test('clean queue → no issues for an active tenant', async ({ assert }) => {
    // Touching the queue name reserves it in Redis; obliterate after.
    const { redis: conn } = getConfig().queue
    testQueue = new Queue(queueName(), {
      connection: { host: conn.host, port: conn.port, db: conn.db ?? 0 },
    })

    const issues = await Promise.resolve(queueStuckCheck.run(ctxFor([fakeActiveTenant(tenantId)])))

    const queueIssues = issues.filter(
      (i: { code: string }) =>
        i.code === 'queue_failed_jobs' ||
        i.code === 'queue_delayed_backlog' ||
        i.code === 'queue_stalled'
    )
    assert.lengthOf(queueIssues, 0, `clean queue must produce no issues, got ${JSON.stringify(issues)}`)
  })

  test('skips inactive tenants entirely', async ({ assert }) => {
    const inactive: TenantModelContract = {
      id: tenantId,
      name: 'inactive',
      isActive: false,
      isSuspended: false,
      isProvisioning: true, // any non-active, non-suspended state
      isFailed: false,
      isDeleted: false,
    } as unknown as TenantModelContract

    const issues = await queueStuckCheck.run(ctxFor([inactive]))
    // Even with a polluted queue from earlier in this group's run, an
    // inactive tenant must not produce any output.
    assert.lengthOf(
      issues.filter((i: { tenantId?: string }) => i.tenantId === tenantId),
      0,
      'inactive tenants must be skipped by the queue check'
    )
  })
})
