import { test } from '@japa/runner'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'

test.group('request.tenant() — memoization (integration)', () => {
  test('returns the same object reference on repeated calls within one request', async ({
    client,
    assert,
  }) => {
    const tenant = await createTestTenant({ status: 'active' })
    try {
      const response = await client
        .get('/tenant/double-fetch')
        .header('x-tenant-id', tenant.id)

      response.assertStatus(200)
      const body = response.body()
      assert.equal(body.id, tenant.id)
      assert.isTrue(body.sameObject, 'request.tenant() must return the same object reference on repeated calls')
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })

  test('tenant() correctly resolves on first call before memoization is set', async ({
    client,
    assert,
  }) => {
    const tenant = await createTestTenant({ status: 'active' })
    try {
      const r1 = await client.get('/tenant/ping').header('x-tenant-id', tenant.id)
      const r2 = await client.get('/tenant/ping').header('x-tenant-id', tenant.id)

      r1.assertStatus(200)
      r2.assertStatus(200)
      assert.equal(r1.body().id, tenant.id)
      assert.equal(r2.body().id, tenant.id)
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })

  test('different tenants resolve independently in separate requests', async ({
    client,
    assert,
  }) => {
    const t1 = await createTestTenant({ status: 'active' })
    const t2 = await createTestTenant({ status: 'active' })
    try {
      const r1 = await client.get('/tenant/ping').header('x-tenant-id', t1.id)
      const r2 = await client.get('/tenant/ping').header('x-tenant-id', t2.id)

      r1.assertStatus(200)
      r2.assertStatus(200)
      assert.equal(r1.body().id, t1.id)
      assert.equal(r2.body().id, t2.id)
      assert.notEqual(r1.body().id, r2.body().id)
    } finally {
      await destroyTestTenant(t1.id)
      await destroyTestTenant(t2.id)
    }
  })
})
