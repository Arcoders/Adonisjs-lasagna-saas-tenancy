import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { BillingService } from '@adonisjs-lasagna/saas-tenancy/services'
import { MockStripe } from '@adonisjs-lasagna/saas-tenancy/testing'
import {
  StripeCustomer,
  StripeSubscription,
} from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import TenantDestroyBillingListener from '../../../src/listeners/tenant_destroy_billing_listener.js'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, clearBillingTables } from './helpers.js'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Tenant hard-delete lifecycle. Three policies via
 * `config.billing.onTenantDelete`:
 *   - 'cancel' (default) — cancel active subs in Stripe + drop local mapping
 *   - 'detach' — leave Stripe alone, drop local mapping
 *   - 'preserve' — no-op (operator handles cleanup)
 */
test.group('Tenant destroy billing listener (integration)', (group) => {
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

  async function seed(): Promise<{
    tenant: TenantModelContract
    stripeCustomerId: string
    stripeSubscriptionId: string
  }> {
    const t = await createTestTenant()
    cleanupTenants.push(t.id)
    const fakeTenant = { id: t.id, name: t.name, email: t.email } as unknown as TenantModelContract

    const stripeCustomerId = `cus_${randomUUID().slice(0, 8)}`
    const cus = new StripeCustomer()
    cus.tenantId = t.id
    cus.stripeCustomerId = stripeCustomerId
    await cus.save()

    const stripeSubscriptionId = `sub_${randomUUID().slice(0, 8)}`
    const sub = new StripeSubscription()
    sub.stripeSubscriptionId = stripeSubscriptionId
    sub.tenantId = t.id
    sub.status = 'active'
    sub.currentPeriodStart = DateTime.utc().minus({ days: 1 })
    sub.currentPeriodEnd = DateTime.utc().plus({ days: 29 })
    sub.cancelAtPeriodEnd = false
    sub.cancelAt = null
    sub.canceledAt = null
    sub.trialEnd = null
    sub.planName = 'pro'
    sub.lastEventAt = DateTime.utc().minus({ minutes: 1 })
    sub.raw = {}
    await sub.save()

    return { tenant: fakeTenant, stripeCustomerId, stripeSubscriptionId }
  }

  test("default 'cancel' policy: calls stripe.subscriptions.cancel + drops local customer", async ({
    assert,
  }) => {
    const { tenant, stripeCustomerId, stripeSubscriptionId } = await seed()
    const billing = await app.container.make(BillingService)
    const mock = new MockStripe('whsec_test_billing_helper')

    // Pre-seed the mock with this subscription so cancel() finds it.
    await mock.subscriptions.create({
      customer: stripeCustomerId,
      items: [{ price: 'price_pro_monthly' }],
    })
    // Manually swap the mock's id to our subId so cancel(subId) hits.
    ;(mock as unknown as { _buildSubscriptions: () => unknown })._buildSubscriptions
    // Easier: just inject by calling cancel through retrieve/store path.
    const all = (mock.subscriptions as unknown as { list: (p: unknown) => AsyncIterable<{ id: string }> })
      .list({})
    // We can't easily rename the mock's auto-generated id. Instead we
    // monkey-patch cancel to record the input.
    const cancelled: string[] = []
    const originalCancel = mock.subscriptions.cancel
    mock.subscriptions.cancel = async (id) => {
      cancelled.push(id)
      return originalCancel.call(mock.subscriptions, id).catch(() => ({
        id,
        status: 'canceled' as const,
        customer: stripeCustomerId,
        items: { data: [] },
        current_period_start: 0,
        current_period_end: 0,
        cancel_at_period_end: false,
      }))
    }
    void all
    billing.__setStripeForTests(mock)

    await new TenantDestroyBillingListener().handle(tenant)

    assert.deepEqual(cancelled, [stripeSubscriptionId], 'cancel called with the active sub')
    const cus = await StripeCustomer.find(tenant.id)
    assert.isNull(cus, 'local stripe_customers row removed')
    // The subscription row stays (audit value > storage cost).
    const sub = await StripeSubscription.find(stripeSubscriptionId)
    assert.isNotNull(sub)
    assert.equal(sub?.status, 'canceled')
  })

  test("'detach' policy: NO Stripe call, only drops local mapping", async ({ assert }) => {
    const cfg = getConfig()
    setConfig({
      ...cfg,
      billing: { ...cfg.billing!, onTenantDelete: 'detach' },
    } as never)

    const { tenant, stripeSubscriptionId } = await seed()
    const billing = await app.container.make(BillingService)
    const mock = new MockStripe('whsec_test_billing_helper')
    let cancelled = false
    mock.subscriptions.cancel = async (id) => {
      cancelled = true
      return {
        id,
        status: 'canceled' as const,
        customer: 'cus_x',
        items: { data: [] },
        current_period_start: 0,
        current_period_end: 0,
        cancel_at_period_end: false,
      }
    }
    billing.__setStripeForTests(mock)

    await new TenantDestroyBillingListener().handle(tenant)

    assert.isFalse(cancelled, 'detach must NOT call Stripe cancel')
    const cus = await StripeCustomer.find(tenant.id)
    assert.isNull(cus, 'local mapping still removed')
    const sub = await StripeSubscription.find(stripeSubscriptionId)
    assert.isNotNull(sub, 'sub row preserved')
    assert.equal(sub?.status, 'active', 'status untouched on detach')
  })

  test("'preserve' policy: no-op", async ({ assert }) => {
    const cfg = getConfig()
    setConfig({
      ...cfg,
      billing: { ...cfg.billing!, onTenantDelete: 'preserve' },
    } as never)

    const { tenant, stripeSubscriptionId } = await seed()
    const billing = await app.container.make(BillingService)
    const mock = new MockStripe('whsec_test_billing_helper')
    let cancelled = false
    mock.subscriptions.cancel = async (id) => {
      cancelled = true
      return {
        id,
        status: 'canceled' as const,
        customer: 'cus_x',
        items: { data: [] },
        current_period_start: 0,
        current_period_end: 0,
        cancel_at_period_end: false,
      }
    }
    billing.__setStripeForTests(mock)

    await new TenantDestroyBillingListener().handle(tenant)

    assert.isFalse(cancelled, 'preserve = no Stripe call')
    const cus = await StripeCustomer.find(tenant.id)
    assert.isNotNull(cus, 'preserve keeps the local mapping intact')
    const sub = await StripeSubscription.find(stripeSubscriptionId)
    assert.isNotNull(sub)
  })

  test('without a customer mapping, the listener does nothing', async ({ assert }) => {
    const t = await createTestTenant()
    cleanupTenants.push(t.id)
    const fakeTenant = { id: t.id, name: t.name, email: t.email } as unknown as TenantModelContract

    const billing = await app.container.make(BillingService)
    const mock = new MockStripe('whsec_test_billing_helper')
    let cancelCalls = 0
    mock.subscriptions.cancel = async () => {
      cancelCalls += 1
      throw new Error('should not be called')
    }
    billing.__setStripeForTests(mock)

    await new TenantDestroyBillingListener().handle(fakeTenant) // must not throw
    assert.equal(cancelCalls, 0, 'no Stripe call when there is nothing to clean')
  })
})
