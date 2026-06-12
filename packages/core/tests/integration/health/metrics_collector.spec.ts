import { test } from '@japa/runner'
import { collectSnapshot } from '@adonisjs-lasagna/saas-tenancy/health'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'
import type { TenantStatus } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Guards P1-2: the /metrics collector must derive tenant counts from the
 * repository's `countByStatus` aggregate (the fixture repo implements it), not
 * by loading every tenant row. We assert correctness via status deltas so other
 * tenants left by sibling specs can't skew the result.
 */
test.group('collectSnapshot — tenant counts (P1-2)', (group) => {
  const created: string[] = []

  group.each.teardown(async () => {
    await Promise.all(created.splice(0).map((id) => destroyTestTenant(id)))
  })

  async function countsByStatus(): Promise<Record<string, number>> {
    const snap = await collectSnapshot({ includeQueues: false })
    return snap.tenantsByStatus
  }

  test('reflects newly created tenants per status', async ({ assert }) => {
    const before = await countsByStatus()
    const beforeTotalSnap = await collectSnapshot({ includeQueues: false })

    const plan: TenantStatus[] = ['active', 'active', 'suspended']
    for (const status of plan) {
      const t = await createTestTenant({ status })
      created.push(t.id)
    }

    const after = await collectSnapshot({ includeQueues: false })

    assert.equal((after.tenantsByStatus.active ?? 0) - (before.active ?? 0), 2)
    assert.equal((after.tenantsByStatus.suspended ?? 0) - (before.suspended ?? 0), 1)
    assert.equal(after.tenantsTotal - beforeTotalSnap.tenantsTotal, 3)
  })
})
