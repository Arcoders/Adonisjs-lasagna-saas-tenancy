import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { BillingService, QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'
import { MockStripe } from '@adonisjs-lasagna/saas-tenancy/testing'
import {
  StripeCustomer,
  StripeSubscription,
  TenantPlan,
} from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, buildSubscription, clearBillingTables } from './helpers.js'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'

/**
 * BillingService.syncSubscription is the keystone routine — every
 * webhook event lands here. We test:
 *   - creation flow → tenant_plans gets the mapped plan, sub row written
 *   - status change (active → canceled) downgrades to defaultPlan
 *   - unmapped product falls back to defaultPlan (never throws)
 */
test.group('BillingService.syncSubscription (integration)', (group) => {
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
    billing.__resetForTests()
  })

  async function seedCustomer(): Promise<{ tenantId: string; stripeCustomerId: string }> {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const stripeCustomerId = `cus_test_${randomUUID().slice(0, 8)}`
    const cus = new StripeCustomer()
    cus.tenantId = tenant.id
    cus.stripeCustomerId = stripeCustomerId
    await cus.save()
    return { tenantId: tenant.id, stripeCustomerId }
  }

  test('subscription.created upserts the row and assigns the mapped plan', async ({
    assert,
  }) => {
    const { tenantId, stripeCustomerId } = await seedCustomer()
    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const sub = buildSubscription({
      customer: stripeCustomerId,
      productId: 'prod_pro',
      status: 'active',
    })
    const result = await billing.syncSubscription(sub, Math.floor(Date.now() / 1000))

    assert.isNotNull(result)
    assert.equal(result?.plan, 'pro')
    assert.equal(result?.tenant_id, tenantId)

    const row = await StripeSubscription.find(sub.id)
    assert.isNotNull(row)
    assert.equal(row?.tenantId, tenantId)
    assert.equal(row?.status, 'active')
    assert.equal(row?.planName, 'pro')

    const tenantPlan = await TenantPlan.find(tenantId)
    assert.isNotNull(tenantPlan)
    assert.equal(tenantPlan?.planName, 'pro')
    assert.equal(tenantPlan?.source, 'stripe')
  })

  test('subscription.deleted downgrades the tenant to defaultPlan', async ({ assert }) => {
    const { tenantId, stripeCustomerId } = await seedCustomer()
    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    // First activate.
    const sub = buildSubscription({
      customer: stripeCustomerId,
      productId: 'prod_pro',
      status: 'active',
      id: 'sub_to_be_canceled',
    })
    await billing.syncSubscription(sub, Math.floor(Date.now() / 1000))
    let tenantPlan = await TenantPlan.find(tenantId)
    assert.equal(tenantPlan?.planName, 'pro')

    // Now cancel — pass `downgrade: true` (matches the dispatcher's
    // handling for `customer.subscription.deleted`).
    const canceledSub = buildSubscription({
      customer: stripeCustomerId,
      productId: 'prod_pro',
      status: 'canceled',
      id: 'sub_to_be_canceled',
      canceledAt: Math.floor(Date.now() / 1000),
    })
    await billing.syncSubscription(canceledSub, Math.floor(Date.now() / 1000) + 100, {
      downgrade: true,
    })

    tenantPlan = await TenantPlan.find(tenantId)
    assert.equal(tenantPlan?.planName, 'starter', 'downgrade lands on defaultPlan')

    const row = await StripeSubscription.find('sub_to_be_canceled')
    assert.equal(row?.status, 'canceled')
  })

  test('unmapped Stripe product falls back to defaultPlan', async ({ assert }) => {
    const { tenantId, stripeCustomerId } = await seedCustomer()
    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const sub = buildSubscription({
      customer: stripeCustomerId,
      productId: 'prod_unknown_xxx',
      status: 'active',
    })
    const result = await billing.syncSubscription(sub, Math.floor(Date.now() / 1000))

    assert.equal(result?.plan, 'starter', 'falls back to defaultPlan')
    const tenantPlan = await TenantPlan.find(tenantId)
    assert.equal(tenantPlan?.planName, 'starter')
  })

  test('throws BillingException when the customer mapping is missing', async ({ assert }) => {
    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const sub = buildSubscription({ customer: 'cus_unknown_no_mapping', productId: 'prod_pro' })
    await assert.rejects(
      () => billing.syncSubscription(sub, Math.floor(Date.now() / 1000)),
      /no local stripe_customers row/
    )
  })

  test('plan change immediately reflects via QuotaService.getLimit', async ({ assert }) => {
    const { tenantId, stripeCustomerId } = await seedCustomer()
    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))
    const quotas = await app.container.make(QuotaService)

    // starter limit = 100; pro limit = 10_000.
    const fakeTenant = { id: tenantId } as never
    assert.equal(await quotas.getLimit(fakeTenant, 'apiRequests'), 100, 'starts on defaultPlan')

    const sub = buildSubscription({ customer: stripeCustomerId, productId: 'prod_pro' })
    await billing.syncSubscription(sub, Math.floor(Date.now() / 1000))

    assert.equal(
      await quotas.getLimit(fakeTenant, 'apiRequests'),
      10_000,
      'pro plan visible immediately after sync'
    )
  })
})
