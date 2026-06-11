import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import { CircuitBreakerService } from '@adonisjs-lasagna/saas-tenancy/services'
import { createTestTenant, destroyTestTenant, updateTenantStatus } from '../helpers/tenant.js'

/**
 * TenantGuardMiddleware turns tenant lifecycle state into typed HTTP
 * responses. The deployment runbook leans on these exact contracts (an
 * operator watching the 5xx rate needs to know which status means what), so
 * each one is pinned over real HTTP against the fixture's guarded
 * /tenant/ping route:
 *
 *   - suspended            → 403 E_TENANT_SUSPENDED
 *   - soft-deleted         → 403 E_TENANT_SUSPENDED (same path, no enumeration)
 *   - provisioning         → 503 E_TENANT_NOT_READY (the provision-to-active race)
 *   - maintenance flag on  → 503 E_TENANT_MAINTENANCE
 *   - circuit breaker OPEN → 503 E_CIRCUIT_OPEN, and 200 again after reset
 */
test.group('Tenant lifecycle state → typed HTTP responses (integration)', (group) => {
  const cleanupIds: string[] = []

  group.teardown(async () => {
    for (const id of cleanupIds) {
      await destroyTestTenant(id).catch(() => {})
    }
  })

  test('suspended tenant → 403 E_TENANT_SUSPENDED', async ({ client, assert }) => {
    const tenant = await createTestTenant({ status: 'active' })
    cleanupIds.push(tenant.id)

    await updateTenantStatus(tenant.id, 'suspended')
    const res = await client.get('/tenant/ping').header('x-tenant-id', tenant.id)
    res.assertStatus(403)
    assert.equal(res.body().code, 'E_TENANT_SUSPENDED')
  })

  test('soft-deleted tenant → 403 through the same suspended path', async ({ client, assert }) => {
    const tenant = await createTestTenant({ status: 'active' })
    cleanupIds.push(tenant.id)

    await db
      .connection('backoffice')
      .query()
      .from('tenants')
      .where('id', tenant.id)
      .update({ deleted_at: new Date() })

    const res = await client.get('/tenant/ping').header('x-tenant-id', tenant.id)
    res.assertStatus(403)
    assert.equal(res.body().code, 'E_TENANT_SUSPENDED')
  })

  test('provisioning tenant → 503 E_TENANT_NOT_READY', async ({ client, assert }) => {
    const tenant = await createTestTenant({ status: 'provisioning' })
    cleanupIds.push(tenant.id)

    const res = await client.get('/tenant/ping').header('x-tenant-id', tenant.id)
    res.assertStatus(503)
    assert.equal(res.body().code, 'E_TENANT_NOT_READY')
  })

  test('tenant in maintenance → 503 E_TENANT_MAINTENANCE', async ({ client, assert }) => {
    const tenant = await createTestTenant({ status: 'active' })
    cleanupIds.push(tenant.id)

    await db
      .connection('backoffice')
      .query()
      .from('tenants')
      .where('id', tenant.id)
      .update({ maintenance: true, maintenance_message: 'Scheduled migration' })

    const res = await client.get('/tenant/ping').header('x-tenant-id', tenant.id)
    res.assertStatus(503)
    assert.equal(res.body().code, 'E_TENANT_MAINTENANCE')
  })

  test('circuit breaker OPEN → 503 E_CIRCUIT_OPEN, then 200 after reset', async ({
    client,
    assert,
  }) => {
    const tenant = await createTestTenant({ status: 'active' })
    cleanupIds.push(tenant.id)

    const breaker = await app.container.make(CircuitBreakerService)
    breaker.getCircuit(tenant.id).open()
    try {
      const blocked = await client.get('/tenant/ping').header('x-tenant-id', tenant.id)
      blocked.assertStatus(503)
      assert.equal(blocked.body().code, 'E_CIRCUIT_OPEN')
    } finally {
      breaker.reset(tenant.id)
    }

    const recovered = await client.get('/tenant/ping').header('x-tenant-id', tenant.id)
    recovered.assertStatus(200)
    assert.equal(recovered.body().id, tenant.id)
  })
})
