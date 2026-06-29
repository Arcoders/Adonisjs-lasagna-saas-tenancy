import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { ImpersonationService } from '@adonisjs-lasagna/saas-tenancy/services'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { createTestTenant, destroyTestTenant } from '../../../helpers/tenant.js'

const SECRET = 'c'.repeat(64)

/**
 * Tenant binding is the isolation-critical half of impersonation: a token
 * issued for tenant A must never attach an A-scoped context to a request that
 * resolved to tenant B. The check lives in `ImpersonationMiddleware`
 * (`activeTenantId !== verified.tenantId → 401`) and only fires when a tenant
 * context is already active. The `/guarded-impersonation-check` fixture route
 * runs the tenant guard first (seeding `tenancy.currentId()`), then
 * impersonation, so this exercises the real ordering an app would deploy.
 */
test.group('ImpersonationMiddleware — tenant binding (integration)', (group) => {
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(async () => {
    originalConfig = getConfig()
    setConfig({ ...originalConfig, impersonation: { secret: SECRET, defaultDuration: 300 } })
  })

  group.each.teardown(async () => {
    setConfig(originalConfig)
  })

  async function startSessionFor(tenantId: string): Promise<string> {
    const svc = await app.container.make(ImpersonationService)
    const { token } = await svc.start({
      tenantId,
      targetUserId: 'user-1',
      adminId: 'admin-1',
      reason: 'binding-test',
      ipAddress: '198.51.100.7',
    })
    return token
  }

  test('rejects a token issued for a different tenant than the resolved one (401)', async ({
    client,
    assert,
  }) => {
    const tenantB = await createTestTenant({ status: 'active' })
    const tenantAId = randomUUID() // a different tenant the token belongs to
    try {
      const tokenForA = await startSessionFor(tenantAId)
      const r = await client
        .get('/guarded-impersonation-check')
        .header('x-tenant-id', tenantB.id)
        .header('x-impersonation-token', tokenForA)
      r.assertStatus(401)
      assert.equal(r.body().code, 'E_IMPERSONATION_TOKEN_INVALID')
    } finally {
      await destroyTestTenant(tenantB.id)
    }
  })

  test('accepts a token whose tenant matches the resolved tenant (200)', async ({
    client,
    assert,
  }) => {
    const tenantB = await createTestTenant({ status: 'active' })
    try {
      const tokenForB = await startSessionFor(tenantB.id)
      const r = await client
        .get('/guarded-impersonation-check')
        .header('x-tenant-id', tenantB.id)
        .header('x-impersonation-token', tokenForB)
      r.assertStatus(200)
      assert.equal(r.body().impersonation?.tenantId, tenantB.id)
    } finally {
      await destroyTestTenant(tenantB.id)
    }
  })
})
