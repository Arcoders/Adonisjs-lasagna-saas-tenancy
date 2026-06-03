import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { BillingService } from '@adonisjs-lasagna/billing'
import { MockStripe } from '@adonisjs-lasagna/billing'
import { StripeCustomer, StripeSubscription } from '@adonisjs-lasagna/billing'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, buildSubscription, clearBillingTables } from './helpers.js'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'

/**
 * Stripe does NOT guarantee delivery order. Without the `last_event_at`
 * guard, a stale `subscription.updated` re-delivered after a
 * `subscription.deleted` would resurrect a canceled subscription. This
 * spec confirms the guard rejects events older than `last_event_at - 5s`.
 */
test.group('Webhook ordering guard (integration)', (group) => {
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

  test('out-of-order subscription.updated does NOT overwrite a more recent state', async ({
    assert,
  }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const stripeCustomerId = `cus_test_${randomUUID().slice(0, 8)}`
    const cus = new StripeCustomer()
    cus.tenantId = tenant.id
    cus.stripeCustomerId = stripeCustomerId
    await cus.save()

    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    // Step 1: latest event lands first (event_at = now).
    const tNow = Math.floor(Date.now() / 1000)
    const subId = `sub_ordering_${randomUUID().slice(0, 8)}`
    const recent = buildSubscription({
      id: subId,
      customer: stripeCustomerId,
      productId: 'prod_pro',
      status: 'active',
    })
    await billing.syncSubscription(recent, tNow)
    let row = await StripeSubscription.find(subId)
    assert.equal(row?.status, 'active')

    // Step 2: a stale `subscription.updated` arrives 30s OLDER than what
    // we already wrote. The guard should reject it; status stays 'active'.
    const stale = buildSubscription({
      id: subId,
      customer: stripeCustomerId,
      productId: 'prod_pro',
      status: 'past_due',
    })
    const result = await billing.syncSubscription(stale, tNow - 30)
    assert.isNull(result, 'stale event returns null (no-op)')

    row = await StripeSubscription.find(subId)
    assert.equal(row?.status, 'active', 'state unchanged by stale event')
  })

  test('events within the 5s tolerance window still win (typical webhook jitter)', async ({
    assert,
  }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const stripeCustomerId = `cus_test_${randomUUID().slice(0, 8)}`
    const cus = new StripeCustomer()
    cus.tenantId = tenant.id
    cus.stripeCustomerId = stripeCustomerId
    await cus.save()

    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const tNow = Math.floor(Date.now() / 1000)
    const subId = `sub_jitter_${randomUUID().slice(0, 8)}`
    await billing.syncSubscription(
      buildSubscription({
        id: subId,
        customer: stripeCustomerId,
        productId: 'prod_pro',
        status: 'active',
      }),
      tNow
    )

    // 3s earlier — within the 5s jitter tolerance — should be accepted.
    const result = await billing.syncSubscription(
      buildSubscription({
        id: subId,
        customer: stripeCustomerId,
        productId: 'prod_pro',
        status: 'past_due',
      }),
      tNow - 3
    )
    assert.isNotNull(result, '3s-earlier event still applied (within tolerance)')

    const row = await StripeSubscription.find(subId)
    assert.equal(row?.status, 'past_due')
  })
})
