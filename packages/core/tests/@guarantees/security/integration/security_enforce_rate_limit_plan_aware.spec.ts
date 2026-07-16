import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'
import { createTestTenant, destroyTestTenant } from '../../../helpers/tenant.js'

// End-to-end proof that `enforceRateLimit()` reads the limit from the resolved
// tenant's plan (config.plans.definitions[plan].rateLimit) rather than from
// route options. Fixture plans: starter = 3/2s (default), pro = 10/2s. The
// `/rate-limited/plan` route runs tenantGuard then enforceRateLimit with
// bypassInTestEnv:true so the real Redis pipeline runs under app.inTest.
test.group('enforceRateLimit plan-aware (integration, real Redis + PG)', () => {
  test('a starter tenant (default plan) is limited to its plan ceiling of 3', async ({
    client,
    assert,
  }) => {
    const tenant = await createTestTenant({ status: 'active' })
    try {
      for (let i = 1; i <= 3; i++) {
        const r = await client.get('/rate-limited/plan').header('x-tenant-id', tenant.id)
        r.assertStatus(200)
        assert.equal(r.headers()['x-ratelimit-limit'], '3', 'limit comes from the starter plan')
      }
      const over = await client.get('/rate-limited/plan').header('x-tenant-id', tenant.id)
      over.assertStatus(429)
      assert.equal(over.body().code, 'E_TOO_MANY_REQUESTS')
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })

  test('a pro tenant gets the higher plan ceiling (10), proving per-tier limits', async ({
    client,
    assert,
  }) => {
    const tenant = await createTestTenant({ status: 'active' })
    try {
      const quota = await app.container.make(QuotaService)
      await quota.assignPlan(tenant.id, 'pro')

      // Four requests that would 429 a starter tenant all pass on pro.
      for (let i = 1; i <= 4; i++) {
        const r = await client.get('/rate-limited/plan').header('x-tenant-id', tenant.id)
        r.assertStatus(200)
        assert.equal(r.headers()['x-ratelimit-limit'], '10', 'limit comes from the pro plan')
      }
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })

  test('per-tenant isolation: one tenant exhausting its budget does not affect another', async ({
    client,
  }) => {
    const a = await createTestTenant({ status: 'active' })
    const b = await createTestTenant({ status: 'active' })
    try {
      for (let i = 0; i < 3; i++) {
        await client.get('/rate-limited/plan').header('x-tenant-id', a.id)
      }
      const aOver = await client.get('/rate-limited/plan').header('x-tenant-id', a.id)
      aOver.assertStatus(429)

      const bFirst = await client.get('/rate-limited/plan').header('x-tenant-id', b.id)
      bFirst.assertStatus(200)
    } finally {
      await destroyTestTenant(a.id)
      await destroyTestTenant(b.id)
    }
  })
})
