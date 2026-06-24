import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'
import { resolveTenantRepository } from '@adonisjs-lasagna/saas-tenancy/services'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'
import ReportingService from '../../src/reporting_service.js'
import ReportingDashboardController from '../../src/controllers/reporting_dashboard_controller.js'

const conn = () => db.connection('backoffice')
const svc = new ReportingService()
const seeded = new Set<string>()

async function seed(tenantId: string, period: string) {
  seeded.add(tenantId)
  await conn().table('tenant_metrics').insert({
    id: randomUUID(),
    tenant_id: tenantId,
    period,
    request_count: 1,
    error_count: 0,
    bandwidth_bytes: 0,
    created_at: new Date(),
  })
}

async function clearSeeded() {
  if (!seeded.size) return
  await conn()
    .from('tenant_metrics')
    .whereIn('tenant_id', [...seeded])
    .delete()
  seeded.clear()
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

test.group('reporting freshness: getDataAsOf', (group) => {
  group.each.teardown(() => clearSeeded())

  test('returns the latest flushed period (global MAX(period))', async ({ assert }) => {
    const t = randomUUID()
    // a far-future date so it is the global max during this test
    await seed(t, '2099-11-15')
    assert.equal(await svc.getDataAsOf(), '2099-11-15')
  })

  test('dashboard payload carries dataAsOf and stays 200', async ({ assert }) => {
    const t = randomUUID()
    await seed(t, '2099-10-10')
    const controller = new ReportingDashboardController()
    const { ctx, captured } = makeCtx({ since: '2099-10-01', until: '2099-10-31' })
    await controller.dashboard(ctx)
    assert.equal(captured.status, 200)
    assert.property(captured.body.data, 'dataAsOf')
  })
})

test.group('reporting freshness: guard & outage', (group) => {
  const cleanup: string[] = []
  group.each.teardown(async () => {
    await clearSeeded()
    while (cleanup.length) await destroyTestTenant(cleanup.pop()!).catch(() => {})
  })

  test('getDataAsOf refuses to run inside a tenant scope', async ({ assert }) => {
    const t = await createTestTenant({ status: 'active' })
    cleanup.push(t.id)
    const tenant = await (await resolveTenantRepository()).findById(t.id)
    await tenancy.run(tenant!, async () => {
      await assert.rejects(() => svc.getDataAsOf(), /data-leak guard/)
    })
  })

  test('a PG outage on getDataAsOf rejects cleanly', async ({ assert }) => {
    class OutageReporting extends ReportingService {
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
    await assert.rejects(() => new OutageReporting().getDataAsOf(), /simulated PG outage/)
  })
})
