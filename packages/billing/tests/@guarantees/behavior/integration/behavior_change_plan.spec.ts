import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import {
  BillingService,
  BillingDriverRegistry,
  MockStripe,
  getActiveBillingDriver,
} from '@adonisjs-lasagna/billing'
import { BillingCustomer, BillingSubscription } from '@adonisjs-lasagna/billing'
import type { BillingCapability, BillingProviderContract } from '@adonisjs-lasagna/billing'
import { resolveTenantRepository } from '@adonisjs-lasagna/saas-tenancy/services'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, clearBillingTables } from '../../../helpers/helpers.js'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'

/**
 * `BillingService.changePlan` is the *initiator* of an upgrade/downgrade: it
 * validates the price + tenant, then asks the active driver to push the change
 * at the provider. Local mirror + plan reassignment land later via the
 * `subscription.updated` webhook (`syncSubscription`), so changePlan returns void.
 */
type FakeDriver = BillingProviderContract & {
  changeCalls: Array<{ id: string; priceId: string }>
}

function makeFakeDriver(caps: BillingCapability[]): FakeDriver {
  const set = new Set(caps)
  const changeCalls: FakeDriver['changeCalls'] = []
  return {
    name: 'fake-change',
    changeCalls,
    supports: (c: BillingCapability) => set.has(c),
    async verifyConfig() {},
    async ensureCustomer() {
      throw new Error('not used')
    },
    async createCheckoutSession() {
      throw new Error('not used')
    },
    async parseWebhookEvent() {
      throw new Error('not used')
    },
    async changePlan(id: string, opts: { priceId: string }) {
      changeCalls.push({ id, priceId: opts.priceId })
    },
  } as FakeDriver
}

/**
 * Capture a rejected `BillingException`'s stable `billingCode`. Tests assert on
 * the code, never the message — the message is human text (and may be reworded),
 * the `billingCode` is the contract (see BillingException's own JSDoc).
 */
async function billingCodeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn()
  } catch (err) {
    return (err as { billingCode?: string }).billingCode
  }
  return undefined
}

test.group('BillingService.changePlan (integration)', (group) => {
  const cleanupTenants: string[] = []
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(async () => {
    originalConfig = getConfig()
    // `price_pro_monthly` mapped directly so the allowlist fast-path passes
    // without needing the driver's price_lookup.
    setupBillingConfig({
      defaultPlan: 'starter',
      productMappings: { prod_starter: 'starter', prod_pro: 'pro', price_pro_monthly: 'pro' },
    })
    await clearBillingTables()
  })

  group.each.teardown(async () => {
    const registry = await app.container.make(BillingDriverRegistry)
    if (registry.has('stripe')) registry.use('stripe')
    await clearBillingTables()
    while (cleanupTenants.length) {
      const id = cleanupTenants.pop()!
      await destroyTestTenant(id).catch(() => {})
    }
    setConfig(originalConfig)
  })

  async function activate(caps: BillingCapability[]): Promise<FakeDriver> {
    const fake = makeFakeDriver(caps)
    const registry = await app.container.make(BillingDriverRegistry)
    registry.register(fake, { activate: true })
    return fake
  }

  async function seedCustomer(tenantId: string): Promise<void> {
    const cus = new BillingCustomer()
    cus.tenantId = tenantId
    cus.providerCustomerId = `cus_${randomUUID().slice(0, 8)}`
    await cus.save()
  }

  interface SeedSubOpts {
    status?: string
    lastEventAt?: DateTime
    providerSubscriptionId?: string
  }

  async function seedSub(tenantId: string, opts: SeedSubOpts = {}): Promise<string> {
    const sub = new BillingSubscription()
    sub.providerSubscriptionId = opts.providerSubscriptionId ?? `sub_${randomUUID().slice(0, 8)}`
    sub.tenantId = tenantId
    sub.status = (opts.status ?? 'active') as never
    sub.currentPeriodStart = DateTime.utc().minus({ days: 5 })
    sub.currentPeriodEnd = DateTime.utc().plus({ days: 25 })
    sub.cancelAtPeriodEnd = false
    sub.cancelAt = null
    sub.canceledAt = null
    sub.trialEnd = null
    sub.planName = 'starter'
    sub.lastEventAt = opts.lastEventAt ?? DateTime.utc().minus({ minutes: 1 })
    sub.raw = {}
    await sub.save()
    return sub.providerSubscriptionId
  }

  async function seedActiveSub(tenantId: string, opts: SeedSubOpts = {}): Promise<string> {
    await seedCustomer(tenantId)
    return seedSub(tenantId, opts)
  }

  test('pushes the price change to the active subscription via the driver', async ({ assert }) => {
    const fake = await activate(['subscription_update'])
    const t = await createTestTenant()
    cleanupTenants.push(t.id)
    const subId = await seedActiveSub(t.id)

    const repo = await resolveTenantRepository()
    const tenant = await repo.findByIdOrFail(t.id)
    const billing = await app.container.make(BillingService)

    await billing.changePlan(tenant, 'price_pro_monthly')

    assert.deepEqual(fake.changeCalls, [{ id: subId, priceId: 'price_pro_monthly' }])
  })

  for (const status of ['trialing', 'past_due', 'paused'] as const) {
    test(`operates on a "${status}" subscription (an actionable, still-billable state)`, async ({
      assert,
    }) => {
      const fake = await activate(['subscription_update'])
      const t = await createTestTenant()
      cleanupTenants.push(t.id)
      const subId = await seedActiveSub(t.id, { status })

      const repo = await resolveTenantRepository()
      const tenant = await repo.findByIdOrFail(t.id)
      const billing = await app.container.make(BillingService)

      await billing.changePlan(tenant, 'price_pro_monthly')

      assert.deepEqual(fake.changeCalls, [{ id: subId, priceId: 'price_pro_monthly' }])
    })
  }

  test('targets the most recently updated subscription when a tenant has more than one', async ({
    assert,
  }) => {
    const fake = await activate(['subscription_update'])
    const t = await createTestTenant()
    cleanupTenants.push(t.id)

    // One customer, two active subscriptions (no unique constraint forbids it —
    // can happen during a provider-sync race or migration). changePlan must pick
    // the most recently updated one.
    await seedCustomer(t.id)
    await seedSub(t.id, {
      providerSubscriptionId: 'sub_stale',
      lastEventAt: DateTime.utc().minus({ days: 2 }),
    })
    await seedSub(t.id, {
      providerSubscriptionId: 'sub_newest',
      lastEventAt: DateTime.utc().minus({ minutes: 1 }),
    })

    const repo = await resolveTenantRepository()
    const tenant = await repo.findByIdOrFail(t.id)
    const billing = await app.container.make(BillingService)

    await billing.changePlan(tenant, 'price_pro_monthly')

    assert.deepEqual(fake.changeCalls, [{ id: 'sub_newest', priceId: 'price_pro_monthly' }])
  })

  test('throws unsupported_by_driver when the driver lacks subscription_update', async ({
    assert,
  }) => {
    await activate(['subscription_cancel'])
    const t = await createTestTenant()
    cleanupTenants.push(t.id)
    await seedActiveSub(t.id)

    const repo = await resolveTenantRepository()
    const tenant = await repo.findByIdOrFail(t.id)
    const billing = await app.container.make(BillingService)

    assert.equal(
      await billingCodeOf(() => billing.changePlan(tenant, 'price_pro_monthly')),
      'unsupported_by_driver'
    )
  })

  test('throws subscription_not_found when the tenant has no active subscription', async ({
    assert,
  }) => {
    await activate(['subscription_update'])
    const t = await createTestTenant()
    cleanupTenants.push(t.id)

    const repo = await resolveTenantRepository()
    const tenant = await repo.findByIdOrFail(t.id)
    const billing = await app.container.make(BillingService)

    assert.equal(
      await billingCodeOf(() => billing.changePlan(tenant, 'price_pro_monthly')),
      'subscription_not_found'
    )
  })

  test('refuses a deleted tenant', async ({ assert }) => {
    await activate(['subscription_update'])
    const billing = await app.container.make(BillingService)
    const deleted = { id: randomUUID(), status: 'deleted' } as never

    assert.equal(
      await billingCodeOf(() => billing.changePlan(deleted, 'price_pro_monthly')),
      'tenant_not_resolvable'
    )
  })

  test('rejects a price that is not in the allowlist', async ({ assert }) => {
    await activate(['subscription_update'])
    const t = await createTestTenant()
    cleanupTenants.push(t.id)
    await seedActiveSub(t.id)

    const repo = await resolveTenantRepository()
    const tenant = await repo.findByIdOrFail(t.id)
    const billing = await app.container.make(BillingService)

    assert.equal(
      await billingCodeOf(() => billing.changePlan(tenant, 'price_not_allowed')),
      'invalid_price'
    )
  })
})

/**
 * Driver-level coverage for the *actual* `StripeDriver.changePlan` — the
 * `FakeDriver` group above proves the service orchestration, but the real
 * provider call-site (retrieve → first item id → no-items guard → update with
 * proration + a deterministic idempotency key) is only exercised here, against
 * the in-process `MockStripe` double.
 */
test.group('StripeDriver.changePlan (MockStripe, in-process)', (group) => {
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(() => {
    originalConfig = getConfig()
    setupBillingConfig({ defaultPlan: 'starter' })
  })

  group.each.teardown(async () => {
    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()
    setConfig(originalConfig)
  })

  test('swaps the price on the first item, idempotently across a retry', async ({ assert }) => {
    const billing = await app.container.make(BillingService)
    const mock = new MockStripe('whsec_test_change_plan')
    await billing.__setStripeForTests(mock)
    const driver = await getActiveBillingDriver()
    assert.equal(driver.name, 'stripe', 'stripe is the active driver')

    const sub = await mock.subscriptions.create({
      customer: 'cus_change_plan',
      items: [{ price: 'price_starter' }],
    })

    await driver.changePlan!(sub.id, { priceId: 'price_pro_monthly' })
    const after = await mock.subscriptions.retrieve(sub.id)
    assert.equal(after?.items.data[0].price.id, 'price_pro_monthly', 'first item price swapped')

    // A retried identical change converges (same idempotency key) — no throw, no drift.
    await driver.changePlan!(sub.id, { priceId: 'price_pro_monthly' })
    const again = await mock.subscriptions.retrieve(sub.id)
    assert.equal(again?.items.data[0].price.id, 'price_pro_monthly')
  })

  test('throws invalid_stripe_request when the subscription has no items', async ({ assert }) => {
    const billing = await app.container.make(BillingService)
    const mock = new MockStripe('whsec_test_change_plan')
    await billing.__setStripeForTests(mock)
    const driver = await getActiveBillingDriver()

    const empty = await mock.subscriptions.create({ customer: 'cus_empty', items: [] })
    assert.equal(
      await billingCodeOf(() => driver.changePlan!(empty.id, { priceId: 'price_pro_monthly' })),
      'invalid_stripe_request'
    )
  })
})
