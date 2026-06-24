import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'
import { resolveTenantRepository } from '@adonisjs-lasagna/saas-tenancy/services'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'
import ReportingService from '../../src/reporting_service.js'

const svc = new ReportingService()
const conn = () => db.connection('backoffice')
const Y = '2002'
const seeded = new Set<string>()

async function seedMetric(
  tenantId: string,
  period: string,
  m: { requests?: number; errors?: number } = {}
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
      bandwidth_bytes: 0,
      created_at: new Date(),
    })
}

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

async function clearSeeded() {
  if (!seeded.size) return
  const ids = [...seeded]
  await conn().from('tenant_metrics').whereIn('tenant_id', ids).delete()
  await conn().from('tenant_custom_metrics').whereIn('tenant_id', ids).delete()
  seeded.clear()
}

test.group('ReportingService chaos: cross-tenant guard', (group) => {
  const cleanup: string[] = []
  group.each.teardown(async () => {
    await clearSeeded()
    while (cleanup.length) await destroyTestTenant(cleanup.pop()!).catch(() => {})
  })

  test('every public method refuses to run inside a tenant scope', async ({ assert }) => {
    const t = await createTestTenant({ status: 'active' })
    cleanup.push(t.id)
    const repo = await resolveTenantRepository()
    const tenant = await repo.findById(t.id)
    assert.exists(tenant)

    await tenancy.run(tenant!, async () => {
      await assert.rejects(() => svc.getAggregate(), /data-leak guard/)
      await assert.rejects(() => svc.getTopTenants(), /data-leak guard/)
      await assert.rejects(() => svc.getCustomAggregate({ name: 'bookings' }), /data-leak guard/)
      await assert.rejects(() => svc.getCustomMetricsBreakdown(), /data-leak guard/)
      // iterateTenantsByUsage is an async generator — the guard fires on first pull.
      await assert.rejects(async () => {
        for await (const _ of svc.iterateTenantsByUsage()) void _
      }, /data-leak guard/)
    })
  })
})

test.group('ReportingService chaos: SQL injection is neutralized', (group) => {
  group.each.teardown(() => clearSeeded())

  test('a malicious since is parameterized — table survives, query rejects', async ({ assert }) => {
    const t = randomUUID()
    await seedMetric(t, `${Y}-01-01`, { requests: 5 })

    await assert.rejects(() =>
      svc.getAggregate({
        since: "2002-01-01'; DROP TABLE tenant_metrics; --",
        until: `${Y}-12-31`,
      })
    )

    // The table and the row are intact — DROP never executed.
    const rows = await conn().from('tenant_metrics').where('tenant_id', t)
    assert.lengthOf(rows, 1)
  })

  test('a malicious period falls back to day (whitelist) — no injection', async ({ assert }) => {
    const t = randomUUID()
    await seedMetric(t, `${Y}-02-01`, { requests: 7 })
    const rows = await svc.getAggregate({
      period: "month'); DROP TABLE tenant_metrics; --" as any,
      since: `${Y}-02-01`,
      until: `${Y}-02-01`,
    })
    assert.equal(rows[0].totalRequests, 7)
  })

  test('a malicious custom metric name is rejected before any query', async ({ assert }) => {
    const t = randomUUID()
    await seedCustom(t, `${Y}-03-01`, 'bookings', 3)
    await assert.rejects(
      () => svc.getCustomAggregate({ name: "x'; DROP TABLE tenant_custom_metrics; --" }),
      /unsafe metric name/
    )
    const rows = await conn().from('tenant_custom_metrics').where('tenant_id', t)
    assert.lengthOf(rows, 1)
  })

  test('a malicious aggregation collapses to SUM (whitelist)', async ({ assert }) => {
    const t = randomUUID()
    await seedCustom(t, `${Y}-04-01`, 'bookings', 11)
    const res = await svc.getCustomAggregate({
      name: 'bookings',
      since: `${Y}-04-01`,
      until: `${Y}-04-01`,
      aggregation: 'SUM(value); DROP TABLE tenant_custom_metrics; --' as any,
    })
    assert.equal(res.value, 11)
    assert.equal(res.aggregation, 'sum')
  })
})

test.group('ReportingService chaos: concurrency & edge data', (group) => {
  group.each.teardown(() => clearSeeded())

  test('concurrent reads during writes never throw and stay internally consistent', async ({
    assert,
  }) => {
    const base = randomUUID()
    await seedMetric(base, `${Y}-06-01`, { requests: 100, errors: 5 })

    const reads = Array.from({ length: 10 }, () =>
      svc.getAggregate({ period: 'day', since: `${Y}-06-01`, until: `${Y}-06-01` })
    )
    const writes = Array.from({ length: 10 }, () =>
      seedMetric(randomUUID(), `${Y}-06-01`, { requests: 10, errors: 1 })
    )

    const [readResults] = await Promise.all([Promise.all(reads), Promise.all(writes)])

    for (const rows of readResults) {
      for (const r of rows) {
        assert.isAtMost(r.totalErrors, r.totalRequests, 'errors <= requests')
        assert.isAtLeast(r.errorRate, 0)
        assert.isAtMost(r.errorRate, 1)
        assert.isAtMost(r.activeTenants, 11)
      }
    }
  }).timeout(30_000)

  test('large bigint sums stay finite and correct', async ({ assert }) => {
    const t1 = randomUUID()
    const t2 = randomUUID()
    await seedMetric(t1, `${Y}-07-01`, { requests: 2_000_000_000, errors: 1_000_000_000 })
    await seedMetric(t2, `${Y}-07-01`, { requests: 2_000_000_000, errors: 0 })

    const rows = await svc.getAggregate({ period: 'day', since: `${Y}-07-01`, until: `${Y}-07-01` })
    assert.equal(rows[0].totalRequests, 4_000_000_000)
    assert.equal(rows[0].totalErrors, 1_000_000_000)
    assert.closeTo(rows[0].errorRate, 0.25, 1e-9)
    assert.isTrue(Number.isFinite(rows[0].totalRequests))
  })

  test('cross-tenant fuzz: each tenant total is exactly its seeded value (no bleed)', async ({
    assert,
  }) => {
    const tenants = Array.from({ length: 6 }, () => randomUUID())
    for (const [i, tenant] of tenants.entries()) {
      await seedMetric(tenant, `${Y}-08-01`, { requests: (i + 1) * 100 })
    }
    const top = await svc.getTopTenants({ since: `${Y}-08-01`, until: `${Y}-08-01`, limit: 1000 })
    const byTenant = Object.fromEntries(top.map((t) => [t.tenantId, t.requests]))
    for (const [i, tenant] of tenants.entries()) {
      assert.equal(byTenant[tenant], (i + 1) * 100, `tenant ${i} total must not bleed`)
    }
  })
})

// A subclass whose backoffice connection's rawQuery rejects — proves a Postgres
// outage fails cleanly (no hang, no partial result) without exhausting the pool.
class OutageReporting extends ReportingService {
  protected backoffice() {
    return {
      conn: {
        rawQuery: async () => {
          throw new Error('simulated PG outage')
        },
      } as any,
      schema: 'backoffice',
    }
  }
}

test.group('ReportingService chaos: Postgres outage fails clean', (group) => {
  group.each.teardown(() => clearSeeded())

  test('an outage rejects cleanly and the real pool still works afterward', async ({ assert }) => {
    const down = new OutageReporting()
    await assert.rejects(() => down.getAggregate(), /simulated PG outage/)

    // A follow-up real query succeeds — the pool was not exhausted.
    const t = randomUUID()
    await seedMetric(t, `${Y}-09-01`, { requests: 1 })
    const rows = await svc.getAggregate({ period: 'day', since: `${Y}-09-01`, until: `${Y}-09-01` })
    assert.equal(rows[0].totalRequests, 1)
  })
})
