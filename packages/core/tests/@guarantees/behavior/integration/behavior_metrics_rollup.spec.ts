import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { MetricsService } from '@adonisjs-lasagna/saas-tenancy/services'

const conn = () => db.connection('backoffice')
const seeded = new Set<string>()

// The `month` date column comes back from knex as a JS Date (local midnight), not a
// string — normalize it to `yyyy-MM` for assertions.
const ym = (m: unknown): string =>
  m instanceof Date ? DateTime.fromJSDate(m).toFormat('yyyy-MM') : String(m).slice(0, 7)

async function seedDaily(
  tenantId: string,
  period: string,
  m: { requests?: number; errors?: number; bandwidth?: number } = {}
) {
  seeded.add(tenantId)
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

function monthlyRows(tenantIds: string[]) {
  return conn()
    .from('tenant_metrics_monthly')
    .whereIn('tenant_id', tenantIds)
    .orderBy('tenant_id', 'asc')
    .orderBy('month', 'asc')
}

async function clearSeeded() {
  if (!seeded.size) return
  const ids = [...seeded]
  await conn().from('tenant_metrics').whereIn('tenant_id', ids).delete()
  await conn().from('tenant_metrics_monthly').whereIn('tenant_id', ids).delete()
  seeded.clear()
}

const svc = new MetricsService()

test.group('MetricsService.recomputeMonthlyRollup (integration)', (group) => {
  group.each.teardown(() => clearSeeded())

  test('collapses daily rows into one (tenant, month) row with exact sums', async ({ assert }) => {
    const t1 = randomUUID()
    const t2 = randomUUID()
    // 2001-01: two days for t1; 2001-02: one day for t1 + one for t2.
    await seedDaily(t1, '2001-01-05', { requests: 10, errors: 1, bandwidth: 100 })
    await seedDaily(t1, '2001-01-20', { requests: 5, errors: 0, bandwidth: 50 })
    await seedDaily(t1, '2001-02-10', { requests: 7, errors: 2, bandwidth: 70 })
    await seedDaily(t2, '2001-02-15', { requests: 3, errors: 0, bandwidth: 30 })

    await svc.recomputeMonthlyRollup({ since: '2001-01-01', until: '2001-02-28' })

    const rows = await monthlyRows([t1, t2])
    assert.lengthOf(rows, 3)
    const t1jan = rows.find((r: any) => r.tenant_id === t1 && ym(r.month) === '2001-01')
    const t1feb = rows.find((r: any) => r.tenant_id === t1 && ym(r.month) === '2001-02')
    const t2feb = rows.find((r: any) => r.tenant_id === t2 && ym(r.month) === '2001-02')
    assert.equal(Number(t1jan.request_count), 15)
    assert.equal(Number(t1jan.error_count), 1)
    assert.equal(Number(t1jan.bandwidth_bytes), 150)
    assert.equal(Number(t1feb.request_count), 7)
    assert.equal(Number(t2feb.request_count), 3)
  })

  test('is idempotent — re-running overwrites, never accumulates', async ({ assert }) => {
    const t = randomUUID()
    await seedDaily(t, '2001-03-05', { requests: 8 })
    await svc.recomputeMonthlyRollup({ since: '2001-03-01', until: '2001-03-31' })
    await svc.recomputeMonthlyRollup({ since: '2001-03-01', until: '2001-03-31' })

    const rows = await monthlyRows([t])
    assert.lengthOf(rows, 1)
    assert.equal(Number(rows[0].request_count), 8)
  })

  test('re-running after new daily rows in a closed month updates the total', async ({
    assert,
  }) => {
    const t = randomUUID()
    await seedDaily(t, '2001-04-05', { requests: 4 })
    await svc.recomputeMonthlyRollup({ since: '2001-04-01', until: '2001-04-30' })
    await seedDaily(t, '2001-04-25', { requests: 6 })
    await svc.recomputeMonthlyRollup({ since: '2001-04-01', until: '2001-04-30' })

    const rows = await monthlyRows([t])
    assert.lengthOf(rows, 1)
    assert.equal(Number(rows[0].request_count), 10)
  })

  test('CHAOS: many months × tenants cross the per-month chunk boundary', async ({ assert }) => {
    const tenants = [randomUUID(), randomUUID(), randomUUID()]
    // 5 months (2001-05 .. 2001-09) × 3 tenants, 2 days each.
    for (let mo = 5; mo <= 9; mo++) {
      const mm = String(mo).padStart(2, '0')
      for (const t of tenants) {
        await seedDaily(t, `2001-${mm}-03`, { requests: mo })
        await seedDaily(t, `2001-${mm}-17`, { requests: mo })
      }
    }
    await svc.recomputeMonthlyRollup({ since: '2001-05-01', until: '2001-09-30' })

    const rows = await monthlyRows(tenants)
    assert.lengthOf(rows, 5 * 3)
    for (const r of rows as any[]) {
      const mo = Number(ym(r.month).slice(5, 7))
      assert.equal(Number(r.request_count), mo * 2)
    }
  }).timeout(30_000)

  test('a window with no matching daily rows writes nothing (no-op)', async ({ assert }) => {
    const t = randomUUID()
    await seedDaily(t, '2001-10-01', { requests: 1 })
    // recompute a disjoint, empty window
    await svc.recomputeMonthlyRollup({ since: '1990-01-01', until: '1990-12-31' })
    const rows = await monthlyRows([t])
    assert.lengthOf(rows, 0)
  })

  test('CHAOS: a malicious since is parameterized — daily table survives', async ({ assert }) => {
    const t = randomUUID()
    await seedDaily(t, '2001-11-05', { requests: 9 })
    const before = await conn().from('tenant_metrics').where('tenant_id', t)
    await svc
      .recomputeMonthlyRollup({
        since: "2001-11-01'; DROP TABLE tenant_metrics; --",
        until: '2001-11-30',
      })
      .catch(() => {})
    const after = await conn().from('tenant_metrics').where('tenant_id', t)
    assert.lengthOf(after, before.length) // table intact, no injection
  })

  test('CHAOS: large bigint daily values sum exactly in the monthly row', async ({ assert }) => {
    const t = randomUUID()
    await seedDaily(t, '2001-12-01', { requests: 2_000_000_000, bandwidth: 2_000_000_000 })
    await seedDaily(t, '2001-12-02', { requests: 1_500_000_000, bandwidth: 1_500_000_000 })
    await svc.recomputeMonthlyRollup({ since: '2001-12-01', until: '2001-12-31' })
    const rows = await monthlyRows([t])
    assert.lengthOf(rows, 1)
    assert.equal(Number(rows[0].request_count), 3_500_000_000)
    assert.isTrue(Number.isFinite(Number(rows[0].request_count)))
  })

  test('default window excludes the open month', async ({ assert }) => {
    const t = randomUUID()
    const lastMonth = DateTime.utc().minus({ months: 1 }).startOf('month')
    const thisMonth = DateTime.utc().startOf('month')
    await seedDaily(t, lastMonth.plus({ days: 4 }).toFormat('yyyy-MM-dd'), { requests: 11 })
    await seedDaily(t, thisMonth.plus({ days: 1 }).toFormat('yyyy-MM-dd'), { requests: 99 })

    // since pinned to last month; until omitted → defaults to end of last completed month.
    await svc.recomputeMonthlyRollup({ since: lastMonth.toFormat('yyyy-MM-dd') })

    const rows = await monthlyRows([t])
    const months = rows.map((r: any) => ym(r.month))
    assert.include(months, lastMonth.toFormat('yyyy-MM'))
    assert.notInclude(months, thisMonth.toFormat('yyyy-MM')) // open month excluded
  })
})
