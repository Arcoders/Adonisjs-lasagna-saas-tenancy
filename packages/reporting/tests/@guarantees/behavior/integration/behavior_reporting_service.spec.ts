import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'
import ReportingService from '../../../../src/reporting_service.js'

const svc = new ReportingService()
const conn = () => db.connection('backoffice')

// Each reporting integration spec uses a distinct historical year so its
// cross-tenant aggregates only ever see its own seeded rows (getAggregate sums
// every tenant in the window). This file owns 2001.
const Y = '2001'

const seededTenants = new Set<string>()

async function seedMetric(
  tenantId: string,
  period: string,
  m: { requests?: number; errors?: number; bandwidth?: number } = {}
) {
  seededTenants.add(tenantId)
  await conn()
    .table('tenant_metrics')
    .insert({
      id: randomUUID(),
      tenant_id: tenantId,
      period,
      request_count: m.requests ?? 0,
      error_count: m.errors ?? 0,
      bandwidth_bytes: m.bandwidth ?? 0,
      created_at: new Date(),
    })
}

test.group('ReportingService.getAggregate (integration)', (group) => {
  group.each.teardown(async () => {
    if (seededTenants.size) {
      await conn()
        .from('tenant_metrics')
        .whereIn('tenant_id', [...seededTenants])
        .delete()
      seededTenants.clear()
    }
  })

  test('day buckets: exact totals, activeTenants, errorRate, newest-first', async ({ assert }) => {
    const a = randomUUID()
    const b = randomUUID()
    const c = randomUUID()
    for (const d of [`${Y}-01-01`, `${Y}-01-02`, `${Y}-01-03`]) {
      await seedMetric(a, d, { requests: 10, errors: 1, bandwidth: 100 })
      await seedMetric(b, d, { requests: 20, errors: 2, bandwidth: 100 })
      await seedMetric(c, d, { requests: 30, errors: 0, bandwidth: 100 })
    }

    const rows = await svc.getAggregate({ period: 'day', since: `${Y}-01-01`, until: `${Y}-01-03` })

    assert.lengthOf(rows, 3)
    assert.deepEqual(
      rows.map((r) => r.period),
      [`${Y}-01-03`, `${Y}-01-02`, `${Y}-01-01`],
      'newest first'
    )
    for (const r of rows) {
      assert.equal(r.totalRequests, 60)
      assert.equal(r.totalErrors, 3)
      assert.equal(r.totalBandwidthBytes, 300)
      assert.equal(r.activeTenants, 3)
      assert.closeTo(r.errorRate, 3 / 60, 1e-9)
    }
  })

  test('month buckets collapse a month and split across months', async ({ assert }) => {
    const t = randomUUID()
    await seedMetric(t, `${Y}-05-10`, { requests: 5 })
    await seedMetric(t, `${Y}-05-20`, { requests: 7 })
    await seedMetric(t, `${Y}-06-10`, { requests: 3 })

    const rows = await svc.getAggregate({
      period: 'month',
      since: `${Y}-05-01`,
      until: `${Y}-06-30`,
    })
    const byBucket = Object.fromEntries(rows.map((r) => [r.period, r]))
    assert.equal(byBucket[`${Y}-05-01`]?.totalRequests, 12)
    assert.equal(byBucket[`${Y}-06-01`]?.totalRequests, 3)
  })

  test('week buckets split dates more than a week apart', async ({ assert }) => {
    const t = randomUUID()
    await seedMetric(t, `${Y}-09-03`, { requests: 4 })
    await seedMetric(t, `${Y}-09-17`, { requests: 6 })

    const rows = await svc.getAggregate({
      period: 'week',
      since: `${Y}-09-01`,
      until: `${Y}-09-30`,
    })
    assert.lengthOf(rows, 2)
    const total = rows.reduce((acc, r) => acc + r.totalRequests, 0)
    assert.equal(total, 10)
  })

  test('empty window returns []', async ({ assert }) => {
    const rows = await svc.getAggregate({ since: `${Y}-12-01`, until: `${Y}-12-31` })
    assert.deepEqual(rows, [])
  })
})

test.group('ReportingService.getTopTenants (integration)', (group) => {
  group.each.teardown(async () => {
    if (seededTenants.size) {
      await conn()
        .from('tenant_metrics')
        .whereIn('tenant_id', [...seededTenants])
        .delete()
      seededTenants.clear()
    }
  })

  test('returns the busiest N tenants, busiest first', async ({ assert }) => {
    const tenants = Array.from({ length: 5 }, () => randomUUID())
    for (const [i, tenant] of tenants.entries()) {
      await seedMetric(tenant, `${Y}-02-01`, { requests: (i + 1) * 10, errors: i })
    }

    const top = await svc.getTopTenants({ since: `${Y}-02-01`, until: `${Y}-02-01`, limit: 2 })
    assert.lengthOf(top, 2)
    assert.equal(top[0]?.tenantId, tenants[4]) // 50 requests
    assert.equal(top[0]?.requests, 50)
    assert.equal(top[1]?.tenantId, tenants[3]) // 40 requests
  })
})

test.group('ReportingService.iterateTenantsByUsage (integration)', (group) => {
  const cleanupTenants: string[] = []

  group.each.teardown(async () => {
    if (seededTenants.size) {
      await conn()
        .from('tenant_metrics')
        .whereIn('tenant_id', [...seededTenants])
        .delete()
      seededTenants.clear()
    }
    while (cleanupTenants.length) {
      await destroyTestTenant(cleanupTenants.pop()!).catch(() => {})
    }
  })

  test('yields busiest-first, hydrates a soft-deleted tenant, skips a missing one', async ({
    assert,
  }) => {
    const active = await createTestTenant({ status: 'active' })
    const soft = await createTestTenant({ status: 'active' })
    cleanupTenants.push(active.id, soft.id)
    // Soft-delete the second tenant.
    await conn()
      .from('tenants')
      .where('id', soft.id)
      .update({ status: 'deleted', deleted_at: new Date() })

    const missing = randomUUID() // a metric row whose tenant row does not exist

    await seedMetric(active.id, `${Y}-04-01`, { requests: 100 })
    await seedMetric(soft.id, `${Y}-04-01`, { requests: 50 })
    await seedMetric(missing, `${Y}-04-01`, { requests: 75 })

    const yielded: Array<{ id: string; requests: number; isDeleted: boolean }> = []
    for await (const { tenant, usage } of svc.iterateTenantsByUsage({
      since: `${Y}-04-01`,
      until: `${Y}-04-01`,
    })) {
      yielded.push({
        id: tenant.id,
        requests: usage.requests,
        isDeleted: Boolean(tenant.isDeleted),
      })
    }

    const ids = yielded.map((y) => y.id)
    assert.include(ids, active.id, 'active tenant present')
    assert.include(ids, soft.id, 'soft-deleted tenant still reported')
    assert.notInclude(ids, missing, 'missing tenant skipped')
    // busiest-first: active (100) before soft (50)
    assert.isBelow(ids.indexOf(active.id), ids.indexOf(soft.id))
    assert.isTrue(yielded.find((y) => y.id === soft.id)!.isDeleted, 'soft-deleted flagged')
  })
})
