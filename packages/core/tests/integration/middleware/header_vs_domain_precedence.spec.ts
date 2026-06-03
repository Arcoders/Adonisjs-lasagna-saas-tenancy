import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'

/**
 * S1-5: header-vs-domain precedence under CustomDomainMiddleware.
 *
 * Default (legacy) mode: an explicit `x-tenant-id` header wins over a
 * matching `Host`. That's a tenant-hop vector when an attacker knows
 * the custom domain — already covered by the existing spec.
 *
 * Strict mode (this spec): if both signals are present and DISAGREE,
 * the request is rejected with 400. If only one is present, the
 * middleware behaves as before.
 */
test.group('CustomDomainMiddleware — strict mode (header/domain precedence)', () => {
  async function bindTenantToDomain(tenantId: string, domain: string): Promise<void> {
    await db
      .connection('backoffice')
      .query()
      .from('tenants')
      .where('id', tenantId)
      .update({ custom_domain: domain })
  }

  test('strict: rejects with 400 when header disagrees with the host-resolved tenant', async ({
    client,
    assert,
  }) => {
    const tenantA = await createTestTenant({ status: 'active' })
    const tenantB = await createTestTenant({ status: 'active' })
    const domainA = `${randomUUID().slice(0, 8)}.tenant-a.example.com`
    await bindTenantToDomain(tenantA.id, domainA)

    try {
      // Attacker presents tenant A's domain but tenant B's id.
      const res = await client
        .get('/custom-domain-strict-check')
        .header('host', domainA)
        .header('x-tenant-id', tenantB.id)

      res.assertStatus(400)
      const body = res.body() as { code?: string }
      assert.equal(body.code, 'E_TENANT_HEADER_DOMAIN_MISMATCH')
    } finally {
      await destroyTestTenant(tenantA.id)
      await destroyTestTenant(tenantB.id)
    }
  })

  test('strict: accepts when header agrees with the host-resolved tenant', async ({
    client,
    assert,
  }) => {
    const tenant = await createTestTenant({ status: 'active' })
    const domain = `${randomUUID().slice(0, 8)}.tenant-x.example.com`
    await bindTenantToDomain(tenant.id, domain)

    try {
      const res = await client
        .get('/custom-domain-strict-check')
        .header('host', domain)
        .header('x-tenant-id', tenant.id)

      res.assertStatus(200)
      assert.equal((res.body() as any).tenantId, tenant.id)
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })

  test('strict: domain alone resolves the tenant (no header — same as legacy)', async ({
    client,
    assert,
  }) => {
    const tenant = await createTestTenant({ status: 'active' })
    const domain = `${randomUUID().slice(0, 8)}.tenant-y.example.com`
    await bindTenantToDomain(tenant.id, domain)

    try {
      const res = await client.get('/custom-domain-strict-check').header('host', domain)
      res.assertStatus(200)
      assert.equal((res.body() as any).tenantId, tenant.id)
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })

  test('strict: header alone is allowed when host matches no custom domain', async ({
    client,
    assert,
  }) => {
    const tenant = await createTestTenant({ status: 'active' })
    try {
      const res = await client
        .get('/custom-domain-strict-check')
        .header('host', 'unrelated.example.com')
        .header('x-tenant-id', tenant.id)

      // No domain claim exists for that host, so there's nothing to
      // mismatch against — header-based routing remains valid.
      res.assertStatus(200)
      assert.equal((res.body() as any).tenantId, tenant.id)
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })

  test('strict: rejects regardless of port suffix on the Host header', async ({
    client,
    assert,
  }) => {
    const tenantA = await createTestTenant({ status: 'active' })
    const tenantB = await createTestTenant({ status: 'active' })
    const domainA = `${randomUUID().slice(0, 8)}.tenant-port.example.com`
    await bindTenantToDomain(tenantA.id, domainA)

    try {
      const res = await client
        .get('/custom-domain-strict-check')
        .header('host', `${domainA}:443`)
        .header('x-tenant-id', tenantB.id)

      res.assertStatus(400)
      assert.equal((res.body() as any).code, 'E_TENANT_HEADER_DOMAIN_MISMATCH')
    } finally {
      await destroyTestTenant(tenantA.id)
      await destroyTestTenant(tenantB.id)
    }
  })
})
