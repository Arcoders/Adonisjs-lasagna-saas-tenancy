import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'
import { MetricsService, resolveTenantRepository } from '@adonisjs-lasagna/saas-tenancy/services'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'
import ReportingService from '../../../../src/reporting_service.js'

const conn = () => db.connection('backoffice')
const Y = '2005'
const seeded = new Set<string>()
const metrics = new MetricsService()

// A reporting service with the rollup read-path forced on (config seam override).
class RollupReporting extends ReportingService {
  protected rollupsEnabled(): boolean {
    return true
  }
}
const live = new ReportingService() // config has no reporting block, so rollups are off
const rollup = new RollupReporting()

async function seedDaily(tenantId: string, period: string, requests: number, errors = 0) {
  seeded.add(tenantId)
  await conn().table('tenant_metrics').insert({
    id: randomUUID(),
    tenant_id: tenantId,
    period,
    request_count: requests,
    error_count: errors,
    bandwidth_bytes: 0,
    created_at: new Date(),
  })
}

async function clearSeeded() {
  if (!seeded.size) return
  const ids = [...seeded]
  await conn().from('tenant_metrics').whereIn('tenant_id', ids).delete()
  await conn().from('tenant_metrics_monthly').whereIn('tenant_id', ids).delete()
  seeded.clear()
}

test.group('reporting rollup: equivalence with live aggregation', (group) => {
  group.each.teardown(() => clearSeeded())

  test('KEYSTONE: getAggregate(month) from rollup deep-equals live over a closed window', async ({
    assert,
  }) => {
    const t1 = randomUUID()
    const t2 = randomUUID()
    // 3 closed months, multiple days/tenants.
    await seedDaily(t1, `${Y}-01-05`, 10, 1)
    await seedDaily(t1, `${Y}-01-20`, 5, 0)
    await seedDaily(t2, `${Y}-01-15`, 8, 2)
    await seedDaily(t1, `${Y}-02-10`, 7, 1)
    await seedDaily(t2, `${Y}-03-03`, 4, 0)
    await metrics.recomputeMonthlyRollup({ since: `${Y}-01-01`, until: `${Y}-03-31` })

    const opts = { period: 'month' as const, since: `${Y}-01-01`, until: `${Y}-03-31` }
    const fromLive = await live.getAggregate(opts)
    const fromRollup = await rollup.getAggregate(opts)

    assert.deepEqual(fromRollup, fromLive)
    // sanity: the data is non-trivial and newest-first
    assert.isAbove(fromLive.length, 0)
    assert.equal(fromLive[0]?.period.slice(0, 7), `${Y}-03`)
  })

  test('getTopTenants from rollup deep-equals live over a closed month window', async ({
    assert,
  }) => {
    const tenants = [randomUUID(), randomUUID(), randomUUID()]
    for (const [i, t] of tenants.entries()) {
      await seedDaily(t, `${Y}-04-05`, (i + 1) * 100)
      await seedDaily(t, `${Y}-04-25`, (i + 1) * 10)
    }
    await metrics.recomputeMonthlyRollup({ since: `${Y}-04-01`, until: `${Y}-04-30` })

    const opts = { since: `${Y}-04-01`, until: `${Y}-04-30`, limit: 1000 }
    assert.deepEqual(await rollup.getTopTenants(opts), await live.getTopTenants(opts))
  })

  test('day/week granularity ignores the rollup (deep-equals live)', async ({ assert }) => {
    const t = randomUUID()
    await seedDaily(t, `${Y}-05-10`, 12)
    await metrics.recomputeMonthlyRollup({ since: `${Y}-05-01`, until: `${Y}-05-31` })
    const opts = { period: 'day' as const, since: `${Y}-05-01`, until: `${Y}-05-31` }
    assert.deepEqual(await rollup.getAggregate(opts), await live.getAggregate(opts))
  })

  test('partial coverage: query spans beyond the rollup → falls back to live, totals correct', async ({
    assert,
  }) => {
    const t = randomUUID()
    await seedDaily(t, `${Y}-06-10`, 6)
    await seedDaily(t, `${Y}-07-10`, 9)
    await seedDaily(t, `${Y}-08-10`, 4)
    // Roll up only Jun–Jul; query Jun–Aug (Aug uncovered, so it falls back to live).
    await metrics.recomputeMonthlyRollup({ since: `${Y}-06-01`, until: `${Y}-07-31` })

    const opts = { period: 'month' as const, since: `${Y}-06-01`, until: `${Y}-08-31` }
    const res = await rollup.getAggregate(opts)
    const total = res.reduce((a, r) => a + r.totalRequests, 0)
    assert.equal(total, 19) // 6 + 9 + 4, Aug included via live fallback
    assert.deepEqual(res, await live.getAggregate(opts))
  })

  test('custom metrics breakdown is never rolled up (works with rollups on)', async ({
    assert,
  }) => {
    const t = randomUUID()
    await conn()
      .table('tenant_custom_metrics')
      .insert({
        id: randomUUID(),
        tenant_id: t,
        period: `${Y}-09-01`,
        name: 'bookings',
        value: 5,
        created_at: new Date(),
      })
    seeded.add(t)
    const res = await rollup.getCustomMetricsBreakdown({ since: `${Y}-09-01`, until: `${Y}-09-30` })
    const bookings = res.find((r) => r.name === 'bookings')
    assert.exists(bookings)
    assert.isAtLeast(bookings!.total, 5)
    await conn().from('tenant_custom_metrics').where('tenant_id', t).delete()
  })
})

test.group('reporting rollup: chaos & correctness', (group) => {
  const cleanup: string[] = []
  group.each.teardown(async () => {
    await clearSeeded()
    while (cleanup.length) await destroyTestTenant(cleanup.pop()!).catch(() => {})
  })

  test('CHAOS open period: a window ending in the open month is served live', async ({
    assert,
  }) => {
    const t = randomUUID()
    const lastMonth = DateTime.utc().minus({ months: 1 }).startOf('month')
    const thisMonth = DateTime.utc().startOf('month')
    await seedDaily(t, lastMonth.plus({ days: 3 }).toFormat('yyyy-MM-dd'), 50)
    await seedDaily(t, thisMonth.plus({ days: 1 }).toFormat('yyyy-MM-dd'), 70)

    // Default recompute excludes the open month, so the monthly table has no
    // current-month row.
    await metrics.recomputeMonthlyRollup({ since: lastMonth.toFormat('yyyy-MM-dd') })
    const monthlyOpen = await conn()
      .from('tenant_metrics_monthly')
      .where('tenant_id', t)
      .where('month', thisMonth.toFormat('yyyy-MM-dd'))
    assert.lengthOf(monthlyOpen, 0)

    // A month-aligned window ending in the open month takes the live path and sees
    // the current-month rows the rollup never captured.
    const res = await rollup.getAggregate({
      period: 'month',
      since: lastMonth.toFormat('yyyy-MM-dd'),
      until: thisMonth.endOf('month').toFormat('yyyy-MM-dd'),
    })
    const openBucket = res.find((r) => r.period.startsWith(thisMonth.toFormat('yyyy-MM')))
    assert.exists(openBucket, 'open month present → served live, not from the stale-free rollup')
    assert.isAtLeast(openBucket!.totalRequests, 70)
  })

  test('CHAOS: the cross-tenant guard fires before source selection', async ({ assert }) => {
    const t = await createTestTenant({ status: 'active' })
    cleanup.push(t.id)
    const repo = await resolveTenantRepository()
    const tenant = await repo.findById(t.id)
    await tenancy.run(tenant!, async () => {
      await assert.rejects(
        () => rollup.getAggregate({ period: 'month', since: `${Y}-01-01`, until: `${Y}-01-31` }),
        /data-leak guard/
      )
      await assert.rejects(
        () => rollup.getTopTenants({ since: `${Y}-01-01`, until: `${Y}-01-31` }),
        /data-leak guard/
      )
    })
  })

  test('CHAOS: a rollup-bounds outage rejects cleanly; the real pool works after', async ({
    assert,
  }) => {
    class OutageRollup extends RollupReporting {
      protected backoffice(): any {
        return {
          conn: {
            rawQuery: async () => {
              throw new Error('simulated PG outage')
            },
          },
          schema: 'backoffice',
        }
      }
    }
    const down = new OutageRollup()
    await assert.rejects(
      () => down.getAggregate({ period: 'month', since: `${Y}-10-01`, until: `${Y}-10-31` }),
      /simulated PG outage/
    )

    const t = randomUUID()
    await seedDaily(t, `${Y}-10-05`, 3)
    await metrics.recomputeMonthlyRollup({ since: `${Y}-10-01`, until: `${Y}-10-31` })
    const res = await rollup.getAggregate({
      period: 'month',
      since: `${Y}-10-01`,
      until: `${Y}-10-31`,
    })
    assert.isAbove(res.length, 0)
  })

  test('CHAOS: concurrent rollup-served reads during daily writes stay consistent', async ({
    assert,
  }) => {
    const t = randomUUID()
    await seedDaily(t, `${Y}-11-10`, 100, 5)
    await metrics.recomputeMonthlyRollup({ since: `${Y}-11-01`, until: `${Y}-11-30` })

    const opts = { period: 'month' as const, since: `${Y}-11-01`, until: `${Y}-11-30` }
    const reads = Array.from({ length: 10 }, () => rollup.getAggregate(opts))
    const writes = Array.from({ length: 10 }, () => seedDaily(randomUUID(), `${Y}-11-15`, 10, 1))
    const [results] = await Promise.all([Promise.all(reads), Promise.all(writes)])
    for (const rows of results) {
      for (const r of rows) {
        assert.isAtMost(r.totalErrors, r.totalRequests)
        assert.isAtLeast(r.errorRate, 0)
        assert.isAtMost(r.errorRate, 1)
      }
    }
  }).timeout(30_000)
})
