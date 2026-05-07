import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import {
  createTestTenant,
  destroyTestTenant,
  updateTenantStatus,
} from '../helpers/tenant.js'

test.group('TenantGuardMiddleware (integration)', (group) => {
  group.each.setup(async () => {})

  test('GET /health returns 200 without tenant header', async ({ client }) => {
    const response = await client.get('/health')
    response.assertStatus(200)
  })

  test('GET /tenant/ping without header returns 400', async ({ client }) => {
    const response = await client.get('/tenant/ping')
    response.assertStatus(400)
  })

  test('GET /tenant/ping with invalid UUID returns 400', async ({ client }) => {
    const response = await client.get('/tenant/ping').header('x-tenant-id', 'not-a-uuid')
    response.assertStatus(400)
  })

  test('GET /tenant/ping with non-existent tenant UUID returns 404', async ({ client }) => {
    const response = await client.get('/tenant/ping').header('x-tenant-id', randomUUID())
    response.assertStatus(404)
  })

  test('GET /tenant/ping with active tenant returns 200', async ({ client }) => {
    const tenant = await createTestTenant({ status: 'active' })
    try {
      const response = await client.get('/tenant/ping').header('x-tenant-id', tenant.id)
      response.assertStatus(200)
      response.assertBodyContains({ id: tenant.id, status: 'active' })
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })

  test('GET /tenant/ping with suspended tenant returns 403', async ({ client }) => {
    const tenant = await createTestTenant({ status: 'suspended' })
    try {
      const response = await client.get('/tenant/ping').header('x-tenant-id', tenant.id)
      response.assertStatus(403)
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })

  test('GET /tenant/ping with provisioning tenant returns 503', async ({ client }) => {
    const tenant = await createTestTenant({ status: 'provisioning' })
    try {
      const response = await client.get('/tenant/ping').header('x-tenant-id', tenant.id)
      response.assertStatus(503)
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })

  test('GET /tenant/ping with failed tenant returns 503', async ({ client }) => {
    const tenant = await createTestTenant({ status: 'failed' })
    try {
      const response = await client.get('/tenant/ping').header('x-tenant-id', tenant.id)
      response.assertStatus(503)
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })

  test('GET /tenant/ping with soft-deleted tenant returns 403', async ({ client }) => {
    const tenant = await createTestTenant({ status: 'active' })
    try {
      await updateTenantStatus(tenant.id, 'active')
      const db = (await import('@adonisjs/lucid/services/db')).default
      await db
        .connection('backoffice')
        .query()
        .from('tenants')
        .where('id', tenant.id)
        .update({ deleted_at: new Date() })
      const response = await client.get('/tenant/ping').header('x-tenant-id', tenant.id)
      response.assertStatus(403)
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })
})
