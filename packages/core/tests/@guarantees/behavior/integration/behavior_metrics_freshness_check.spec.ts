import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { metricsFreshnessCheck } from '@adonisjs-lasagna/saas-tenancy/services'

const conn = () => db.connection('backoffice')
const ctx = {} as any // the check ignores its context

async function deleteAllMetrics() {
  await conn().from('tenant_metrics').delete()
}

async function seed(period: string) {
  await conn().table('tenant_metrics').insert({
    id: randomUUID(),
    tenant_id: randomUUID(),
    period,
    request_count: 1,
    error_count: 0,
    bandwidth_bytes: 0,
    created_at: new Date(),
  })
}

// The check reads the GLOBAL MAX(period), so each case controls the whole table.
// Integration test data is ephemeral; other specs seed + tear down their own rows.
test.group('metrics_freshness check (integration)', (group) => {
  group.each.teardown(() => deleteAllMetrics())

  test('clean when a recent flush exists', async ({ assert }) => {
    await deleteAllMetrics()
    await seed(DateTime.utc().toFormat('yyyy-MM-dd'))
    const issues = await metricsFreshnessCheck.run(ctx)
    assert.lengthOf(issues, 0)
  })

  test('warns metrics_stale when the latest flush is old', async ({ assert }) => {
    await deleteAllMetrics()
    const old = DateTime.utc().minus({ days: 10 }).toFormat('yyyy-MM-dd')
    await seed(old)
    const issues = await metricsFreshnessCheck.run(ctx)
    assert.lengthOf(issues, 1)
    assert.equal(issues[0].code, 'metrics_stale')
    assert.equal(issues[0].severity, 'warn')
    assert.equal(issues[0].meta?.asOf, old)
    assert.isAtLeast(Number(issues[0].meta?.staleDays), 10)
  })

  test('warns metrics_absent when the table is empty', async ({ assert }) => {
    await deleteAllMetrics()
    const issues = await metricsFreshnessCheck.run(ctx)
    assert.lengthOf(issues, 1)
    assert.equal(issues[0].code, 'metrics_absent')
    assert.equal(issues[0].severity, 'warn')
  })
})
