import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import ace from '@adonisjs/core/services/ace'
import { TenantPlan } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, clearBillingTables } from './helpers.js'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'

/**
 * `tenant:billing:backfill` walks every tenant via the
 * `TenantRepositoryContract.each` cursor and seeds a `tenant_plans` row
 * if one doesn't exist. Used after first install of `--with=billing` on
 * an app with existing tenants.
 *
 * Skip-by-default for tenants that already have a plan. `--force`
 * overwrites — but the typical operator preference is "let Stripe sync
 * win" so the default is non-destructive.
 */
test.group('tenant:billing:backfill (integration)', (group) => {
  const cleanupTenants: string[] = []
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(async () => {
    originalConfig = getConfig()
    setupBillingConfig({ defaultPlan: 'starter' })
    await clearBillingTables()
  })

  group.each.teardown(async () => {
    await clearBillingTables()
    while (cleanupTenants.length) {
      const id = cleanupTenants.pop()!
      await destroyTestTenant(id).catch(() => {})
    }
    setConfig(originalConfig)
  })

  test('seeds defaultPlan for every tenant lacking a row', async ({ assert }) => {
    const a = await createTestTenant()
    const b = await createTestTenant()
    const c = await createTestTenant()
    cleanupTenants.push(a.id, b.id, c.id)

    const cmd = await ace.exec('tenant:billing:backfill', [])
    assert.equal(cmd.exitCode, 0)

    for (const t of [a, b, c]) {
      const row = await TenantPlan.find(t.id)
      assert.isNotNull(row, `tenant ${t.id} got a plan row`)
      assert.equal(row?.planName, 'starter')
      assert.equal(row?.source, 'backfill')
    }
  })

  test('skips tenants that already have a row (does not overwrite)', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)

    // Pre-existing row at "pro" — must be preserved.
    const existing = new TenantPlan()
    existing.tenantId = tenant.id
    existing.planName = 'pro'
    existing.source = 'stripe'
    existing.assignedAt = DateTime.utc().minus({ days: 2 })
    existing.expiresAt = null
    await existing.save()

    const cmd = await ace.exec('tenant:billing:backfill', [])
    assert.equal(cmd.exitCode, 0)

    const row = await TenantPlan.find(tenant.id)
    assert.equal(row?.planName, 'pro', 'existing assignment preserved')
    assert.equal(row?.source, 'stripe', 'source preserved')
  })

  test('--force overwrites existing rows', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)

    const existing = new TenantPlan()
    existing.tenantId = tenant.id
    existing.planName = 'pro'
    existing.source = 'stripe'
    existing.assignedAt = DateTime.utc().minus({ days: 2 })
    existing.expiresAt = null
    await existing.save()

    const cmd = await ace.exec('tenant:billing:backfill', ['--force'])
    assert.equal(cmd.exitCode, 0)

    const row = await TenantPlan.find(tenant.id)
    assert.equal(row?.planName, 'starter', '--force overwrote with defaultPlan')
    assert.equal(row?.source, 'backfill')
  })

  test('--dry-run reports without writing', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)

    const cmd = await ace.exec('tenant:billing:backfill', ['--dry-run'])
    assert.equal(cmd.exitCode, 0)

    const row = await TenantPlan.find(tenant.id)
    assert.isNull(row, 'no row written on dry-run')
  })

  test('--plan honours an explicit plan name', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)

    const cmd = await ace.exec('tenant:billing:backfill', ['--plan=pro'])
    assert.equal(cmd.exitCode, 0)

    const row = await TenantPlan.find(tenant.id)
    assert.equal(row?.planName, 'pro')
  })

  test('exits 1 when --plan points at an undeclared plan', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)

    const cmd = await ace.exec('tenant:billing:backfill', ['--plan=enterprise'])
    assert.equal(cmd.exitCode, 1)

    const row = await TenantPlan.find(tenant.id)
    assert.isNull(row, 'no rows written on validation failure')
  })

  test('idempotent: re-running after a clean backfill is a no-op', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)

    await ace.exec('tenant:billing:backfill', [])
    const first = await TenantPlan.find(tenant.id)
    const firstAt = first!.assignedAt.toISO()

    await new Promise((r) => setTimeout(r, 30))
    await ace.exec('tenant:billing:backfill', [])
    const second = await TenantPlan.find(tenant.id)

    assert.equal(second!.assignedAt.toISO(), firstAt, 'second run does not touch the row')
  })
})
