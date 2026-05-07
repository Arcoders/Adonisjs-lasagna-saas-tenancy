import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'

test.group('CustomDomainMiddleware (integration)', () => {
  test('passes through without resolving tenant when x-tenant-id header is already set', async ({
    client,
    assert,
  }) => {
    const tenant = await createTestTenant({ status: 'active' })
    try {
      const response = await client
        .get('/custom-domain-check')
        .header('x-tenant-id', tenant.id)

      response.assertStatus(200)
      assert.equal(response.body().tenantId, tenant.id)
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })

  test('resolves tenant by custom_domain when no x-tenant-id header is present', async ({
    client,
    assert,
  }) => {
    const tenant = await createTestTenant({ status: 'active' })
    const domain = `${randomUUID().slice(0, 8)}.customer.example.com`

    await db
      .connection('backoffice')
      .query()
      .from('tenants')
      .where('id', tenant.id)
      .update({ custom_domain: domain })

    try {
      const response = await client.get('/custom-domain-check').header('host', domain)

      response.assertStatus(200)
      assert.equal(response.body().tenantId, tenant.id)
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })

  test('returns null tenantId when host does not match any tenant custom_domain', async ({
    client,
    assert,
  }) => {
    const response = await client
      .get('/custom-domain-check')
      .header('host', 'unknown.example.com')

    response.assertStatus(200)
    assert.isNull(response.body().tenantId)
  })

  test('does not override existing x-tenant-id even when custom_domain matches', async ({
    client,
    assert,
  }) => {
    const tenant = await createTestTenant({ status: 'active' })
    const explicitId = randomUUID()
    const domain = `${randomUUID().slice(0, 8)}.customer.example.com`

    await db
      .connection('backoffice')
      .query()
      .from('tenants')
      .where('id', tenant.id)
      .update({ custom_domain: domain })

    try {
      const response = await client
        .get('/custom-domain-check')
        .header('host', domain)
        .header('x-tenant-id', explicitId)

      response.assertStatus(200)
      assert.equal(response.body().tenantId, explicitId, 'explicit header must not be overwritten')
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })

  test('handles host header with port number correctly', async ({ client, assert }) => {
    const tenant = await createTestTenant({ status: 'active' })
    const domain = `${randomUUID().slice(0, 8)}.customer.example.com`

    await db
      .connection('backoffice')
      .query()
      .from('tenants')
      .where('id', tenant.id)
      .update({ custom_domain: domain })

    try {
      const response = await client
        .get('/custom-domain-check')
        .header('host', `${domain}:3000`)

      response.assertStatus(200)
      assert.equal(response.body().tenantId, tenant.id)
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })
})
