import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { DateTime } from 'luxon'
import { QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantPlan } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { __resetPlanStorageProbe } from '../../../src/services/quota_service.js'
import { setupBillingConfig, clearBillingTables } from './helpers.js'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'

/**
 * QuotaService.assignPlan is the package's only public write into
 * `tenant_plans`. We test:
 *   - validation against `definitions`
 *   - idempotent re-assigns (same row → no churn)
 *   - cache invalidation reflects on the next read
 *   - expired rows are treated as missing (grace fallback)
 */
test.group('QuotaService.assignPlan (integration)', (group) => {
  const cleanupTenants: string[] = []
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(async () => {
    originalConfig = getConfig()
    setupBillingConfig({ defaultPlan: 'starter' })
    __resetPlanStorageProbe()
    await clearBillingTables()
  })

  group.each.teardown(async () => {
    await clearBillingTables()
    while (cleanupTenants.length) {
      const id = cleanupTenants.pop()!
      await destroyTestTenant(id).catch(() => {})
    }
    setConfig(originalConfig)
    __resetPlanStorageProbe()
  })

  test('rejects unknown plan names', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const quotas = await app.container.make(QuotaService)

    await assert.rejects(
      () => quotas.assignPlan(tenant.id, 'enterprise'),
      /plan "enterprise" is not declared/
    )
  })

  test('writes a row, reads it back via the storage-backed getPlanFor', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const quotas = await app.container.make(QuotaService)

    await quotas.assignPlan(tenant.id, 'pro', { source: 'stripe' })

    const row = await TenantPlan.find(tenant.id)
    assert.isNotNull(row)
    assert.equal(row?.planName, 'pro')
    assert.equal(row?.source, 'stripe')

    const fakeTenant = { id: tenant.id } as never
    const { name } = await quotas.getPlanFor(fakeTenant)
    assert.equal(name, 'pro')
  })

  test('re-assigning the same plan is a no-op (does not bump assigned_at unnecessarily)', async ({
    assert,
  }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const quotas = await app.container.make(QuotaService)

    await quotas.assignPlan(tenant.id, 'pro', { source: 'stripe' })
    const first = await TenantPlan.find(tenant.id)
    const firstAt = first!.assignedAt.toISO()

    // Sleep a hair so a write would produce a different timestamp.
    await new Promise((r) => setTimeout(r, 50))

    await quotas.assignPlan(tenant.id, 'pro', { source: 'stripe' })
    const second = await TenantPlan.find(tenant.id)

    assert.equal(second!.assignedAt.toISO(), firstAt, 'no-op skips the write')
  })

  test('changing plan invalidates the cache, next read sees the new plan', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const quotas = await app.container.make(QuotaService)
    const fakeTenant = { id: tenant.id } as never

    await quotas.assignPlan(tenant.id, 'starter', { source: 'manual' })
    assert.equal(await quotas.getLimit(fakeTenant, 'apiRequests'), 100)

    await quotas.assignPlan(tenant.id, 'pro', { source: 'stripe' })
    assert.equal(
      await quotas.getLimit(fakeTenant, 'apiRequests'),
      10_000,
      'cache busted on write'
    )
  })

  test('expired rows fall through to defaultPlan', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const quotas = await app.container.make(QuotaService)

    await quotas.assignPlan(tenant.id, 'pro', {
      source: 'stripe',
      expiresAt: DateTime.utc().minus({ minutes: 5 }),
    })

    const fakeTenant = { id: tenant.id } as never
    const { name } = await quotas.getPlanFor(fakeTenant)
    assert.equal(name, 'starter', 'expired row treated as missing')
  })

  test('downgrade resets EVERY quota dimension, not just the one read first', async ({
    assert,
  }) => {
    // Reconfigure plans with two limit dimensions. The plan-name cache
    // is keyed per tenant (not per dimension), so a downgrade must make
    // the next read of ANY dimension reflect the new plan — this guards
    // against a regression that caches resolved limits per dimension.
    const cfg = getConfig()
    setConfig({
      ...cfg,
      plans: {
        ...cfg.plans!,
        defaultPlan: 'starter',
        storage: 'tenant_plans',
        definitions: {
          starter: { limits: { apiRequests: 100, storageMb: 5 } },
          pro: { limits: { apiRequests: 10_000, storageMb: 500 } },
        },
      },
    } as never)
    __resetPlanStorageProbe()

    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const quotas = await app.container.make(QuotaService)
    const fakeTenant = { id: tenant.id } as never

    await quotas.assignPlan(tenant.id, 'pro', { source: 'stripe' })
    assert.equal(await quotas.getLimit(fakeTenant, 'apiRequests'), 10_000)
    assert.equal(await quotas.getLimit(fakeTenant, 'storageMb'), 500)

    await quotas.assignPlan(tenant.id, 'starter', { source: 'dunning' })
    assert.equal(await quotas.getLimit(fakeTenant, 'apiRequests'), 100, 'apiRequests reset')
    assert.equal(await quotas.getLimit(fakeTenant, 'storageMb'), 5, 'storageMb reset too')
  })

  test('clearAssignedPlan removes the row + cache', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const quotas = await app.container.make(QuotaService)
    const fakeTenant = { id: tenant.id } as never

    await quotas.assignPlan(tenant.id, 'pro', { source: 'stripe' })
    assert.equal(await quotas.getLimit(fakeTenant, 'apiRequests'), 10_000)

    await quotas.clearAssignedPlan(tenant.id)
    assert.isNull(await TenantPlan.find(tenant.id))
    assert.equal(await quotas.getLimit(fakeTenant, 'apiRequests'), 100, 'falls back to defaultPlan')
  })
})
