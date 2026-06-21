import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { BillingService } from '@adonisjs-lasagna/billing'
import { MockStripe } from '@adonisjs-lasagna/billing'
import { BillingCustomer, BillingSubscription } from '@adonisjs-lasagna/billing'
import { TenantPlan } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, buildNeutralSubscription, clearBillingTables } from './helpers.js'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'

/**
 * A7: a late or replayed provider event must not resurrect a DELETED tenant's
 * plan/quota. A hard delete drops the customer mirror (and `syncSubscription`
 * already throws `tenant_not_resolvable`), but a soft status flip can leave the
 * mirror in place — so the tenant-state guard checks the host tenant's
 * lifecycle status and no-ops for `deleted`.
 */
test.group('Tenant-state guard on subscription sync (integration)', (group) => {
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
    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()
  })

  test('syncSubscription no-ops for a deleted tenant whose mirror survives', async ({ assert }) => {
    // Soft status flip: status='deleted' but the billing_customers row remains.
    const tenant = await createTestTenant({ status: 'deleted' })
    cleanupTenants.push(tenant.id)
    const providerCustomerId = `cus_test_${randomUUID().slice(0, 8)}`
    const cus = new BillingCustomer()
    cus.tenantId = tenant.id
    cus.providerCustomerId = providerCustomerId
    await cus.save()

    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const subId = `sub_deleted_${randomUUID().slice(0, 8)}`
    const result = await billing.syncSubscription(
      buildNeutralSubscription({
        id: subId,
        customer: providerCustomerId,
        productId: 'prod_pro',
        status: 'active',
      }),
      Math.floor(Date.now() / 1000)
    )

    assert.isNull(result, 'deleted tenant → no-op')
    assert.isNull(await BillingSubscription.find(subId), 'no mirror row written')
    assert.isNull(await TenantPlan.find(tenant.id), 'no plan/quota resurrected')
  })

  test('syncSubscription still applies for an active tenant (guard does not over-block)', async ({
    assert,
  }) => {
    const tenant = await createTestTenant() // active
    cleanupTenants.push(tenant.id)
    const providerCustomerId = `cus_test_${randomUUID().slice(0, 8)}`
    const cus = new BillingCustomer()
    cus.tenantId = tenant.id
    cus.providerCustomerId = providerCustomerId
    await cus.save()

    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const subId = `sub_active_${randomUUID().slice(0, 8)}`
    const result = await billing.syncSubscription(
      buildNeutralSubscription({
        id: subId,
        customer: providerCustomerId,
        productId: 'prod_pro',
        status: 'active',
      }),
      Math.floor(Date.now() / 1000)
    )

    assert.equal(result?.plan, 'pro', 'active tenant processed normally')
    assert.isNotNull(await BillingSubscription.find(subId))
  })
})
