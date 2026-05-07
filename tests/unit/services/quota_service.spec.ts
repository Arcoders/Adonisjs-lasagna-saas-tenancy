import { test } from '@japa/runner'
import QuotaService from '../../../src/services/quota_service.js'
import { buildTestTenant } from '../../../src/testing/builders.js'
import { setupTestConfig, testConfig } from '../../helpers/config.js'

function setupPlans(
  definitions: Record<string, { limits: Record<string, number> }>,
  defaultPlan = 'standard',
  getPlan?: (t: any) => string | undefined
) {
  setupTestConfig({
    ...testConfig,
    plans: { defaultPlan, definitions, getPlan },
  } as any)
}

test.group('QuotaService — getPlanFor', () => {
  test('falls back to defaultPlan when no resolver is provided', async ({ assert }) => {
    setupPlans({ standard: { limits: { apiCallsPerDay: 1000 } } })
    const svc = new QuotaService()
    const tenant = buildTestTenant()
    const { name, plan } = await svc.getPlanFor(tenant)
    assert.equal(name, 'standard')
    assert.equal(plan.limits.apiCallsPerDay, 1000)
  })

  test('honors per-tenant getPlan resolver', async ({ assert }) => {
    setupPlans(
      {
        free: { limits: { apiCallsPerDay: 100 } },
        pro: { limits: { apiCallsPerDay: 10000 } },
      },
      'free',
      (t) => (t.name.includes('VIP') ? 'pro' : undefined)
    )
    const svc = new QuotaService()
    const free = buildTestTenant({ name: 'Acme' })
    const vip = buildTestTenant({ name: 'VIP-1' })
    assert.equal((await svc.getPlanFor(free)).name, 'free')
    assert.equal((await svc.getPlanFor(vip)).name, 'pro')
  })

  test('throws when resolved plan is not declared', async ({ assert }) => {
    setupPlans({ standard: { limits: {} } }, 'enterprise')
    const svc = new QuotaService()
    await assert.rejects(
      () => svc.getPlanFor(buildTestTenant()),
      /plan "enterprise"/
    )
  })

  test('synthesizes a permissive default when no plans config exists', async ({ assert }) => {
    setupTestConfig() // no plans key
    const svc = new QuotaService()
    const { name, plan } = await svc.getPlanFor(buildTestTenant())
    assert.equal(name, '__default__')
    assert.deepEqual(plan.limits, {})
  })
})

test.group('QuotaService — getLimit', () => {
  test('returns the declared limit for a known quota', async ({ assert }) => {
    setupPlans({ standard: { limits: { apiCallsPerDay: 500, seats: 5 } } })
    const svc = new QuotaService()
    const tenant = buildTestTenant()
    assert.equal(await svc.getLimit(tenant, 'apiCallsPerDay'), 500)
    assert.equal(await svc.getLimit(tenant, 'seats'), 5)
  })

  test('returns Infinity when a quota is not declared in the plan', async ({ assert }) => {
    setupPlans({ standard: { limits: { apiCallsPerDay: 500 } } })
    const svc = new QuotaService()
    const tenant = buildTestTenant()
    const limit = await svc.getLimit(tenant, 'unknownQuota')
    assert.equal(limit, Number.POSITIVE_INFINITY)
  })

  test('returns Infinity when the synthesized __default__ plan applies', async ({ assert }) => {
    setupTestConfig() // no plans config
    const svc = new QuotaService()
    const limit = await svc.getLimit(buildTestTenant(), 'apiCallsPerDay')
    assert.equal(limit, Number.POSITIVE_INFINITY)
  })

  test('honors per-tenant resolver when computing the limit', async ({ assert }) => {
    setupPlans(
      {
        free: { limits: { apiCallsPerDay: 100 } },
        pro: { limits: { apiCallsPerDay: 10000 } },
      },
      'free',
      (t) => (t.email.endsWith('@pro.example') ? 'pro' : undefined)
    )
    const svc = new QuotaService()
    const free = buildTestTenant({ email: 'a@free.example' })
    const pro = buildTestTenant({ email: 'b@pro.example' })
    assert.equal(await svc.getLimit(free, 'apiCallsPerDay'), 100)
    assert.equal(await svc.getLimit(pro, 'apiCallsPerDay'), 10000)
  })
})
