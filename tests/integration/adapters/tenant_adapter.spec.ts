import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'

test.group('TenantAdapter (integration)', () => {
  test('request with valid tenant header resolves connection from header', async ({ client }) => {
    const tenant = await createTestTenant({ status: 'active' })
    try {
      const response = await client.get('/tenant/connection').header('x-tenant-id', tenant.id)
      response.assertStatus(200)
      response.assertBodyContains({ connectionName: `tenant_${tenant.id}` })
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })

  test('request without x-tenant-id header returns 400', async ({ client }) => {
    const response = await client.get('/tenant/connection')
    response.assertStatus(400)
  })

  test('request with malformed UUID in header returns 400', async ({ client }) => {
    const response = await client
      .get('/tenant/connection')
      .header('x-tenant-id', 'bad-id-format')
    response.assertStatus(400)
  })

  test('request with valid UUIDv4 but unknown tenant returns 404', async ({ client }) => {
    const response = await client.get('/tenant/connection').header('x-tenant-id', randomUUID())
    response.assertStatus(404)
  })

  test('each tenant gets its own prefixed connection name', async ({ client }) => {
    const t1 = await createTestTenant({ status: 'active' })
    const t2 = await createTestTenant({ status: 'active' })
    try {
      const r1 = await client.get('/tenant/connection').header('x-tenant-id', t1.id)
      const r2 = await client.get('/tenant/connection').header('x-tenant-id', t2.id)
      r1.assertStatus(200)
      r2.assertStatus(200)
      r1.assertBodyContains({ connectionName: `tenant_${t1.id}` })
      r2.assertBodyContains({ connectionName: `tenant_${t2.id}` })
    } finally {
      await destroyTestTenant(t1.id)
      await destroyTestTenant(t2.id)
    }
  })
})
