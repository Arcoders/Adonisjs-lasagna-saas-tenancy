import { test } from '@japa/runner'
import { createTestTenant, destroyTestTenant } from '../../../helpers/tenant.js'

/**
 * The router scope macros driven through the booted HTTP stack. This tier is
 * the one that was missing: the macros once handed `route.use()` bare
 * middleware instances, and the route executor invokes any non-function
 * entry as `handle(containerResolver, ctx, next)`, so the middleware ran
 * with the container resolver where it expects the HttpContext and every
 * macro-scoped request died in a 500. The structural unit specs kept
 * passing because they only asserted what the group wrapped, never what the
 * executor could run. These requests are the regression pin; the fixture
 * mounts the routes at /macro/* (tests/fixtures/start/routes.ts).
 */
test.group('router scope macros over real HTTP (integration)', () => {
  test('router.central() serves a tenant-less request and refuses a tenant one with 404', async ({
    client,
  }) => {
    const ok = await client.get('/macro/central-ping')
    ok.assertStatus(200)
    ok.assertBodyContains({ ok: true })

    const tenant = await createTestTenant({ status: 'active' })
    try {
      // E_CENTRAL_ROUTE_VIOLATION carries a 404: the route does not exist on
      // the tenant plane. A 500 here is the executor-contract regression.
      const refused = await client.get('/macro/central-ping').header('x-tenant-id', tenant.id)
      refused.assertStatus(404)
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })

  test('router.tenant() resolves the tenant and reaches the handler', async ({
    client,
    assert,
  }) => {
    const tenant = await createTestTenant({ status: 'active' })
    try {
      const res = await client.get('/macro/tenant-ping').header('x-tenant-id', tenant.id)
      res.assertStatus(200)
      assert.equal(res.body().id, tenant.id)
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })

  test('router.tenant() answers a missing tenant header with the guard 400, never a 500', async ({
    client,
  }) => {
    const res = await client.get('/macro/tenant-ping')
    res.assertStatus(400)
  })

  test('router.universal() serves both with and without a tenant', async ({ client }) => {
    const anonymous = await client.get('/macro/universal-ping')
    anonymous.assertStatus(200)

    const tenant = await createTestTenant({ status: 'active' })
    try {
      const withTenant = await client.get('/macro/universal-ping').header('x-tenant-id', tenant.id)
      withTenant.assertStatus(200)
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })
})
