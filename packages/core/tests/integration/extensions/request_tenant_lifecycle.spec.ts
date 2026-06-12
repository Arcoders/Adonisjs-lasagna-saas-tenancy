import { test } from '@japa/runner'
import { createTestTenant, destroyTestTenant, updateTenantStatus } from '../helpers/tenant.js'

/**
 * P2-3: `request.tenant()` must be fail-closed on lifecycle by itself, not
 * only behind the guard middleware. The routes used here are deliberately
 * mounted WITHOUT TenantGuardMiddleware (see fixtures/start/routes.ts), so a
 * pass proves the macro's own floor: a suspended tenant is rejected with the
 * same 403 the guard would produce, and `{ allowInactive: true }` is the
 * explicit escape hatch for admin/recovery flows.
 */
test.group('request.tenant() — lifecycle fail-closed (integration)', () => {
  test('an active tenant is served on the unguarded route', async ({ client, assert }) => {
    const tenant = await createTestTenant({ status: 'active' })
    try {
      const res = await client.get('/unguarded-tenant').header('x-tenant-id', tenant.id)
      res.assertStatus(200)
      assert.equal(res.body().id, tenant.id)
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })

  test('a suspended tenant is rejected with 403 even though no guard ran', async ({
    client,
    assert,
  }) => {
    const tenant = await createTestTenant({ status: 'active' })
    try {
      await updateTenantStatus(tenant.id, 'suspended')
      const res = await client.get('/unguarded-tenant').header('x-tenant-id', tenant.id)
      assert.equal(
        res.status(),
        403,
        'request.tenant() must fail closed on a suspended tenant without relying on the guard middleware'
      )
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })

  test('allowInactive: true serves the suspended tenant (explicit admin opt-in)', async ({
    client,
    assert,
  }) => {
    const tenant = await createTestTenant({ status: 'active' })
    try {
      await updateTenantStatus(tenant.id, 'suspended')
      const res = await client.get('/unguarded-tenant-inactive').header('x-tenant-id', tenant.id)
      res.assertStatus(200)
      assert.equal(res.body().id, tenant.id)
      assert.equal(res.body().status, 'suspended')
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })

  test('guarded routes keep their semantics: suspended tenant still 403 via the guard path', async ({
    client,
    assert,
  }) => {
    const tenant = await createTestTenant({ status: 'active' })
    try {
      await updateTenantStatus(tenant.id, 'suspended')
      const res = await client.get('/tenant/ping').header('x-tenant-id', tenant.id)
      assert.equal(res.status(), 403)
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })
})
