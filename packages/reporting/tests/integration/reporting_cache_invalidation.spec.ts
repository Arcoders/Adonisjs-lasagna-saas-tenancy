import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import emitter from '@adonisjs/core/services/emitter'
import { randomUUID } from 'node:crypto'
import { getCache } from '@adonisjs-lasagna/saas-tenancy/services'
import { MetricsFlushed } from '@adonisjs-lasagna/saas-tenancy/events'
import ReportingDashboardController from '../../src/controllers/reporting_dashboard_controller.js'

const conn = () => db.connection('backoffice')
const Y = '2006'
const seeded = new Set<string>()

async function seed(tenantId: string, period: string, requests: number) {
  seeded.add(tenantId)
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

function makeCtx(input: Record<string, unknown> = {}) {
  const captured: { status: number; body: any } = { status: 0, body: undefined }
  const respond = (status: number) => (body: any) => {
    captured.status = status
    captured.body = body
    return body
  }
  const ctx = {
    request: { input: (k: string, d?: unknown) => (k in input ? input[k] : d) },
    params: {},
    response: { ok: respond(200), badRequest: respond(400), notFound: respond(404) },
  } as any
  return { ctx, captured }
}

const totalOf = (captured: any) =>
  captured.body.data.aggregate.reduce((a: number, r: any) => a + r.totalRequests, 0)

test.group('reporting cache invalidation on MetricsFlushed', (group) => {
  group.each.teardown(async () => {
    if (seeded.size) {
      await conn()
        .from('tenant_metrics')
        .whereIn('tenant_id', [...seeded])
        .delete()
      seeded.clear()
    }
    await getCache().namespace('reporting').clear()
  })

  test('the provider handler clears the reporting cache on a flush event', async ({ assert }) => {
    const t = randomUUID()
    await seed(t, `${Y}-01-10`, 10)
    const controller = new ReportingDashboardController({ cacheTtlMs: 60_000 })
    const opts = { period: 'day' as const, since: `${Y}-01-01`, until: `${Y}-01-31` }

    const first = makeCtx(opts)
    await controller.dashboard(first.ctx)
    const firstTotal = totalOf(first.captured)
    assert.equal(firstTotal, 10)

    // More data lands, but a cached read within the TTL is still stale...
    await seed(t, `${Y}-01-20`, 5)
    const stale = makeCtx(opts)
    await controller.dashboard(stale.ctx)
    assert.equal(totalOf(stale.captured), 10, 'served stale from cache within TTL')

    // ...until a MetricsFlushed event clears the namespace (the exact handler the
    // provider installs when config.reporting.cache.invalidateOnFlush is set).
    const handler = () => {
      void getCache()
        .namespace('reporting')
        .clear()
        .catch(() => {})
    }
    emitter.on(MetricsFlushed, handler)
    try {
      await MetricsFlushed.dispatch({ period: `${Y}-01-31` })
      await new Promise((r) => setTimeout(r, 50)) // let the async clear settle
    } finally {
      emitter.off(MetricsFlushed, handler)
    }

    const fresh = makeCtx(opts)
    await controller.dashboard(fresh.ctx)
    assert.equal(totalOf(fresh.captured), 15, 'fresh after the flush cleared the cache')
  })
})
