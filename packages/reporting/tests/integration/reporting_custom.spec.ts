import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import ReportingService from '../../src/reporting_service.js'

const svc = new ReportingService()
const conn = () => db.connection('backoffice')
const Y = '2003'
const seeded = new Set<string>()

async function seedCustom(tenantId: string, period: string, name: string, value: number) {
  seeded.add(tenantId)
  await conn().table('tenant_custom_metrics').insert({
    id: randomUUID(),
    tenant_id: tenantId,
    period,
    name,
    value,
    created_at: new Date(),
  })
}

test.group('ReportingService.getCustomAggregate (integration)', (group) => {
  group.each.teardown(async () => {
    if (seeded.size) {
      await conn()
        .from('tenant_custom_metrics')
        .whereIn('tenant_id', [...seeded])
        .delete()
      seeded.clear()
    }
  })

  test('each whitelisted aggregation computes correctly', async ({ assert }) => {
    const a = randomUUID()
    const b = randomUUID()
    await seedCustom(a, `${Y}-01-01`, 'bookings', 10)
    await seedCustom(b, `${Y}-01-01`, 'bookings', 20)
    const win = { name: 'bookings', since: `${Y}-01-01`, until: `${Y}-01-01` }

    assert.equal((await svc.getCustomAggregate({ ...win, aggregation: 'sum' })).value, 30)
    assert.equal((await svc.getCustomAggregate({ ...win, aggregation: 'avg' })).value, 15)
    assert.equal((await svc.getCustomAggregate({ ...win, aggregation: 'count' })).value, 2)
    assert.equal((await svc.getCustomAggregate({ ...win, aggregation: 'max' })).value, 20)
    assert.equal((await svc.getCustomAggregate({ ...win, aggregation: 'min' })).value, 10)
  })

  test('defaults to sum and reports the resolved aggregation', async ({ assert }) => {
    const a = randomUUID()
    await seedCustom(a, `${Y}-02-01`, 'revenue_cents', 1299)
    const res = await svc.getCustomAggregate({
      name: 'revenue_cents',
      since: `${Y}-02-01`,
      until: `${Y}-02-01`,
    })
    assert.equal(res.value, 1299)
    assert.equal(res.aggregation, 'sum')
  })

  test('an unregistered name still aggregates (config is metadata, not a gate)', async ({
    assert,
  }) => {
    const a = randomUUID()
    await seedCustom(a, `${Y}-03-01`, 'never_in_config', 42)
    const res = await svc.getCustomAggregate({
      name: 'never_in_config',
      since: `${Y}-03-01`,
      until: `${Y}-03-01`,
    })
    assert.equal(res.value, 42)
  })

  test('empty custom data → value 0, no NaN', async ({ assert }) => {
    const res = await svc.getCustomAggregate({
      name: 'bookings',
      since: `${Y}-11-01`,
      until: `${Y}-11-30`,
    })
    assert.equal(res.value, 0)
  })
})

test.group('ReportingService.getCustomMetricsBreakdown (integration)', (group) => {
  group.each.teardown(async () => {
    if (seeded.size) {
      await conn()
        .from('tenant_custom_metrics')
        .whereIn('tenant_id', [...seeded])
        .delete()
      seeded.clear()
    }
  })

  test('per-name totals across tenants, busiest first', async ({ assert }) => {
    const a = randomUUID()
    const b = randomUUID()
    await seedCustom(a, `${Y}-05-01`, 'bookings', 10)
    await seedCustom(b, `${Y}-05-01`, 'bookings', 5)
    await seedCustom(a, `${Y}-05-01`, 'revenue_cents', 100)

    const rows = await svc.getCustomMetricsBreakdown({ since: `${Y}-05-01`, until: `${Y}-05-01` })
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.total]))
    assert.equal(byName['bookings'], 15)
    assert.equal(byName['revenue_cents'], 100)
  })

  test('empty window → []', async ({ assert }) => {
    const rows = await svc.getCustomMetricsBreakdown({ since: `${Y}-12-01`, until: `${Y}-12-31` })
    assert.deepEqual(rows, [])
  })
})
