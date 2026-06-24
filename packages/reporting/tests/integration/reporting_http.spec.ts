import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { getCache } from '@adonisjs-lasagna/saas-tenancy/services'
import ReportingDashboardController from '../../src/controllers/reporting_dashboard_controller.js'
import { multitenancyReportingRoutes } from '../../src/routes.js'

const conn = () => db.connection('backoffice')
const Y = '2004'
const seededTenants = new Set<string>()

async function seedMetric(tenantId: string, period: string, requests: number) {
  seededTenants.add(tenantId)
  await conn().table('tenant_metrics').insert({
    id: randomUUID(),
    tenant_id: tenantId,
    period,
    request_count: requests,
    error_count: 0,
    bandwidth_bytes: 0,
    created_at: new Date(),
  })
}

interface Captured {
  status: number
  body: any
}

function makeCtx(input: Record<string, unknown> = {}) {
  const captured: Captured = { status: 0, body: undefined }
  const respond = (status: number) => (body: any) => {
    captured.status = status
    captured.body = body
    return body
  }
  const ctx = {
    request: {
      input: (key: string, def?: unknown) => (key in input ? input[key] : def),
    },
    params: {},
    response: {
      ok: respond(200),
      badRequest: respond(400),
      notFound: respond(404),
    },
  } as any
  return { ctx, captured }
}

test.group('ReportingDashboardController.dashboard (integration)', (group) => {
  group.each.teardown(async () => {
    if (seededTenants.size) {
      await conn()
        .from('tenant_metrics')
        .whereIn('tenant_id', [...seededTenants])
        .delete()
      seededTenants.clear()
    }
    await getCache().namespace('reporting').clear()
  })

  test('200 with { data: { aggregate, topTenants, customMetrics } }', async ({ assert }) => {
    await seedMetric(randomUUID(), `${Y}-01-10`, 10)
    const controller = new ReportingDashboardController()
    const { ctx, captured } = makeCtx({ period: 'day', since: `${Y}-01-01`, until: `${Y}-01-31` })

    await controller.dashboard(ctx)

    assert.equal(captured.status, 200)
    assert.properties(captured.body.data, ['aggregate', 'topTenants', 'customMetrics'])
    assert.equal(captured.body.data.aggregate[0].totalRequests, 10)
  })

  test('400 on a bad period', async ({ assert }) => {
    const controller = new ReportingDashboardController()
    const { ctx, captured } = makeCtx({ period: 'bogus' })
    await controller.dashboard(ctx)
    assert.equal(captured.status, 400)
  })

  test('400 on a non-ISO since/until', async ({ assert }) => {
    const controller = new ReportingDashboardController()
    for (const bad of [{ since: 'nope' }, { until: '2026-13-40' }]) {
      const { ctx, captured } = makeCtx(bad)
      await controller.dashboard(ctx)
      assert.equal(captured.status, 400)
    }
  })

  test('400 on an over-wide window (max-range guard)', async ({ assert }) => {
    const controller = new ReportingDashboardController({ maxRangeDays: 10 })
    const { ctx, captured } = makeCtx({ since: `${Y}-01-01`, until: `${Y}-03-01` })
    await controller.dashboard(ctx)
    assert.equal(captured.status, 400)
    assert.match(captured.body.error, /window too wide/)
  })

  test('400 on an inverted window', async ({ assert }) => {
    const controller = new ReportingDashboardController()
    const { ctx, captured } = makeCtx({ since: `${Y}-12-01`, until: `${Y}-01-01` })
    await controller.dashboard(ctx)
    assert.equal(captured.status, 400)
  })

  test('a non-positive / non-numeric limit is accepted (default applied)', async ({ assert }) => {
    await seedMetric(randomUUID(), `${Y}-05-10`, 3)
    const controller = new ReportingDashboardController()
    for (const limit of [-5, 'abc']) {
      const { ctx, captured } = makeCtx({ since: `${Y}-05-01`, until: `${Y}-05-31`, limit })
      await controller.dashboard(ctx)
      assert.equal(captured.status, 200)
    }
  })

  // CHAOS / caching: a cached response is served stale within TTL; a different
  // query is a miss and reflects fresh data — proving the cache is correct and
  // scoped by params (and global, never tenant-scoped).
  test('caches by params: stale within TTL, miss on different params', async ({ assert }) => {
    const t = randomUUID()
    await seedMetric(t, `${Y}-07-15`, 10)
    const controller = new ReportingDashboardController({ cacheTtlMs: 60_000 })

    const first = makeCtx({ period: 'day', since: `${Y}-07-01`, until: `${Y}-07-31` })
    await controller.dashboard(first.ctx)
    assert.equal(first.captured.body.data.aggregate[0].totalRequests, 10)

    // Insert more data for the SAME window after caching.
    await seedMetric(t, `${Y}-07-16`, 5)

    const cached = makeCtx({ period: 'day', since: `${Y}-07-01`, until: `${Y}-07-31` })
    await controller.dashboard(cached.ctx)
    const cachedTotal = cached.captured.body.data.aggregate.reduce(
      (acc: number, r: any) => acc + r.totalRequests,
      0
    )
    assert.equal(cachedTotal, 10, 'served the stale cached result within TTL')

    // Different params → cache miss → fresh data (sees both rows).
    const fresh = makeCtx({ period: 'day', since: `${Y}-07-01`, until: `${Y}-08-31` })
    await controller.dashboard(fresh.ctx)
    const freshTotal = fresh.captured.body.data.aggregate.reduce(
      (acc: number, r: any) => acc + r.totalRequests,
      0
    )
    assert.equal(freshTotal, 15, 'a different query is a cache miss and reflects fresh data')
  })
})

test.group('multitenancyReportingRoutes (integration)', () => {
  test('throws when middleware is omitted (fail-closed)', ({ assert }) => {
    assert.throws(() => multitenancyReportingRoutes({}), /middleware. is required/)
  })

  test('throws on the dangerous empty-array middleware', ({ assert }) => {
    assert.throws(() => multitenancyReportingRoutes({ middleware: [] }), /middleware. is required/)
  })
})
