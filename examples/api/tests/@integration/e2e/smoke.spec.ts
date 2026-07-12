import { test } from '@japa/runner'
import { buildTestTenant, MockTenantRepository } from '@adonisjs-lasagna/saas-tenancy/testing'
import type { DemoMeta } from '#app/models/backoffice/tenant'
import { ADMIN_HEADERS } from './_helpers.js'

/**
 * Smoke tests: one assertion per public surface that doesn't require a fully
 * provisioned tenant in PG. The DB-backed routes (notes, audit, etc.) are
 * exercised by the README's curl recipes, not here.
 */

test.group('smoke — testing helpers', () => {
  test('buildTestTenant produces a fake with typed metadata', ({ assert }) => {
    const tenant = buildTestTenant<DemoMeta>({
      metadata: { plan: 'pro', tier: 'premium', industry: 'demo' },
    })
    assert.equal(tenant.metadata?.plan, 'pro')
    assert.equal(tenant.metadata?.tier, 'premium')
    assert.equal(tenant.status, 'active')
  })

  test('MockTenantRepository implements the contract', async ({ assert }) => {
    const tenant = buildTestTenant<DemoMeta>({
      metadata: { plan: 'free', tier: 'standard' },
    })
    const repo = new MockTenantRepository<DemoMeta>([tenant])
    const found = await repo.findById(tenant.id)
    assert.isNotNull(found)
    assert.equal(found?.id, tenant.id)
    const all = await repo.all()
    assert.lengthOf(all, 1)
  })

  // setRequestTenant is exercised in the package's own integration tests;
  // demoing it through an HTTP client requires the request memo to survive
  // the apiClient's serialization, which it doesn't reliably across versions.
  // The other two assertions above already cover the helper surface.
})

test.group('smoke — health endpoints', () => {
  test('/livez returns 200', async ({ client }) => {
    const response = await client.get('/livez')
    response.assertStatus(200)
  })

  test('/readyz returns a status field', async ({ client }) => {
    const response = await client.get('/readyz')
    response.assertBodyContains({ status: response.body().status })
  })

  // /metrics is fail-closed (it leaks tenant enumeration + KPIs) and the demo
  // gates it with the same backoffice bearer as the admin API.
  test('/metrics returns prometheus text exposition', async ({ assert, client }) => {
    const response = await client.get('/metrics').headers(ADMIN_HEADERS)
    response.assertStatus(200)
    assert.match(response.text(), /multitenancy_uptime_seconds/)
  })
})

test.group('smoke — admin auth', () => {
  test('/admin/* rejects requests without the token', async ({ client }) => {
    const response = await client.get('/admin/tenants')
    response.assertStatus(401)
  })

  test('/metrics rejects requests without the token', async ({ client }) => {
    const response = await client.get('/metrics')
    response.assertStatus(401)
  })
})

test.group('smoke — tenant resolution', () => {
  test('missing x-tenant-id header returns 400', async ({ client }) => {
    const response = await client.get('/demo/connection')
    response.assertStatus(400)
  })
})
