import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import ace from '@adonisjs/core/services/ace'
import { DateTime } from 'luxon'
import { BillingService } from '@adonisjs-lasagna/billing'
import { MockStripe } from '@adonisjs-lasagna/billing'
import { TenantPlan } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'
import { setupBillingConfig, clearBillingTables } from './helpers.js'

/**
 * `tenant:billing:pricing:validate` is a CI gate: exit 0 when the plan/price
 * config is internally consistent and the provider is reachable, exit 1 on a
 * real misconfiguration (product mapped to an undefined plan, a tenant stranded
 * on a removed plan, an unreachable/invalid key). Provider price resolution is
 * warn-only and never fails the gate.
 */
test.group('tenant:billing:pricing:validate (integration)', (group) => {
  const cleanupTenants: string[] = []
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(async () => {
    originalConfig = getConfig()
    setupBillingConfig({ defaultPlan: 'starter' })
    await clearBillingTables()
    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))
  })

  group.each.teardown(async () => {
    await clearBillingTables()
    while (cleanupTenants.length) {
      const id = cleanupTenants.pop()!
      await destroyTestTenant(id).catch(() => {})
    }
    setConfig(originalConfig)
    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()
  })

  test('exits 0 when config is consistent and the provider is reachable', async ({ assert }) => {
    const cmd = await ace.exec('tenant:billing:pricing:validate', ['--json'])
    assert.equal(cmd.exitCode, 0)
  })

  test('exits 1 when a product maps to an undefined plan', async ({ assert }) => {
    setupBillingConfig({ defaultPlan: 'starter', productMappings: { prod_ghost: 'nonexistent' } })
    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const cmd = await ace.exec('tenant:billing:pricing:validate', ['--json'])
    assert.equal(cmd.exitCode, 1)
  })

  test('exits 1 when an active tenant is on a plan that no longer exists', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)

    const tp = new TenantPlan()
    tp.tenantId = tenant.id
    tp.planName = 'ghost_plan' // not in plans.definitions
    tp.source = 'stripe'
    tp.assignedAt = DateTime.utc()
    tp.expiresAt = null
    await tp.save()

    const cmd = await ace.exec('tenant:billing:pricing:validate', ['--json'])
    assert.equal(cmd.exitCode, 1)
  })
})
