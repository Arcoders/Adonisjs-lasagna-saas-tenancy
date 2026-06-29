import { test } from '@japa/runner'
import { createTestTenant, destroyTestTenant } from '../../../helpers/tenant.js'

// End-to-end proof that the opt-in `authorizeTenantAccess` gate closes the
// cross-tenant IDOR through the real guard + HTTP + PostgreSQL stack. The
// fixture config wires an authorizer that only evaluates requests carrying the
// `x-test-principal-tenant` header (a stand-in for an authenticated principal's
// tenant); without it the gate is a no-op, which is the documented trust
// boundary the seam exists to let hosts close.
test.group('TenantGuardMiddleware authorizeTenantAccess (integration)', () => {
  test('serves the request when the principal belongs to the resolved tenant', async ({
    client,
  }) => {
    const tenant = await createTestTenant({ status: 'active' })
    try {
      const response = await client
        .get('/tenant/ping')
        .header('x-tenant-id', tenant.id)
        .header('x-test-principal-tenant', tenant.id)
      response.assertStatus(200)
      response.assertBodyContains({ id: tenant.id })
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })

  test('returns 403 on a tenant-id swap (caller belongs to a different tenant)', async ({
    client,
  }) => {
    const victim = await createTestTenant({ status: 'active' })
    const attacker = await createTestTenant({ status: 'active' })
    try {
      const response = await client
        .get('/tenant/ping')
        .header('x-tenant-id', victim.id) // resolve to the victim's schema
        .header('x-test-principal-tenant', attacker.id) // but the caller is from another tenant
      response.assertStatus(403)
    } finally {
      await destroyTestTenant(victim.id)
      await destroyTestTenant(attacker.id)
    }
  })

  test('without the membership header the request is served (documented trust boundary)', async ({
    client,
  }) => {
    const tenant = await createTestTenant({ status: 'active' })
    try {
      const response = await client.get('/tenant/ping').header('x-tenant-id', tenant.id)
      response.assertStatus(200)
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })
})
