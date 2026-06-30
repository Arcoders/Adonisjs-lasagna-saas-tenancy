import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { BillingService, BillingDriverRegistry } from '@adonisjs-lasagna/billing'
import { BillingCustomer, BillingSubscription } from '@adonisjs-lasagna/billing'
import type { BillingCapability, BillingProviderContract } from '@adonisjs-lasagna/billing'
import { QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantPlan } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, clearBillingTables } from '../../../helpers/helpers.js'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'

/**
 * `BillingService.cancelSubscription` reflects a cancel in the local mirror and
 * emulates an *immediate* cancel for drivers that can only cancel at period end
 * (Lemon Squeezy): it revokes access now by reassigning `defaultPlan`, while a
 * capability-bearing driver (Stripe/Paddle) leaves the downgrade to its deletion
 * webhook.
 */
type FakeDriver = BillingProviderContract & {
  cancelCalls: Array<{ id: string; opts?: { atPeriodEnd?: boolean } }>
}

function makeFakeDriver(caps: BillingCapability[]): FakeDriver {
  const set = new Set(caps)
  const cancelCalls: FakeDriver['cancelCalls'] = []
  return {
    name: 'fake-cancel',
    cancelCalls,
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
    async cancelSubscription(id: string, opts?: { atPeriodEnd?: boolean }) {
      cancelCalls.push({ id, opts })
    },
  } as FakeDriver
}

test.group('BillingService.cancelSubscription (integration)', (group) => {
  const cleanupTenants: string[] = []
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(async () => {
    originalConfig = getConfig()
    setupBillingConfig({ defaultPlan: 'starter' })
    await clearBillingTables()
  })

  group.each.teardown(async () => {
    // Restore the active driver to the booted Stripe one for other specs.
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

  async function seedSub(): Promise<{ tenantId: string; subId: string }> {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const cus = new BillingCustomer()
    cus.tenantId = tenant.id
    cus.providerCustomerId = `cus_${randomUUID().slice(0, 8)}`
    await cus.save()

    const sub = new BillingSubscription()
    sub.providerSubscriptionId = `sub_${randomUUID().slice(0, 8)}`
    sub.tenantId = tenant.id
    sub.status = 'active'
    sub.currentPeriodStart = DateTime.utc().minus({ days: 5 })
    sub.currentPeriodEnd = DateTime.utc().plus({ days: 25 })
    sub.cancelAtPeriodEnd = false
    sub.cancelAt = null
    sub.canceledAt = null
    sub.trialEnd = null
    sub.planName = 'pro'
    sub.lastEventAt = DateTime.utc().minus({ minutes: 1 })
    sub.raw = {}
    await sub.save()

    const quotas = await app.container.make(QuotaService)
    await quotas.assignPlan(tenant.id, 'pro', { source: 'stripe' })
    return { tenantId: tenant.id, subId: sub.providerSubscriptionId }
  }

  test('immediate cancel on a driver WITHOUT subscription_cancel_immediate revokes access locally', async ({
    assert,
  }) => {
    const fake = await activate(['subscription_cancel'])
    const seed = await seedSub()
    const billing = await app.container.make(BillingService)

    await billing.cancelSubscription(seed.subId, { atPeriodEnd: false })

    assert.deepEqual(fake.cancelCalls, [{ id: seed.subId, opts: { atPeriodEnd: false } }])

    const sub = await BillingSubscription.find(seed.subId)
    assert.equal(sub?.status, 'canceled')
    assert.isNotNull(sub?.canceledAt)

    const plan = await TenantPlan.find(seed.tenantId)
    assert.equal(plan?.planName, 'starter', 'access revoked immediately via emulated downgrade')
  })

  test('immediate cancel on a capable driver does NOT locally downgrade (webhook handles it)', async ({
    assert,
  }) => {
    await activate(['subscription_cancel', 'subscription_cancel_immediate'])
    const seed = await seedSub()
    const billing = await app.container.make(BillingService)

    await billing.cancelSubscription(seed.subId, { atPeriodEnd: false })

    const sub = await BillingSubscription.find(seed.subId)
    assert.equal(sub?.status, 'canceled')

    const plan = await TenantPlan.find(seed.tenantId)
    assert.equal(plan?.planName, 'pro', 'no local downgrade — deletion webhook will downgrade')
  })

  test('atPeriodEnd:true flags cancelAtPeriodEnd and leaves status untouched', async ({
    assert,
  }) => {
    const fake = await activate(['subscription_cancel', 'subscription_cancel_immediate'])
    const seed = await seedSub()
    const billing = await app.container.make(BillingService)

    await billing.cancelSubscription(seed.subId, { atPeriodEnd: true })

    assert.deepEqual(fake.cancelCalls, [{ id: seed.subId, opts: { atPeriodEnd: true } }])
    const sub = await BillingSubscription.find(seed.subId)
    assert.equal(sub?.status, 'active', 'stays active until period end')
    assert.isTrue(sub?.cancelAtPeriodEnd)

    const plan = await TenantPlan.find(seed.tenantId)
    assert.equal(plan?.planName, 'pro', 'no downgrade at period-end cancel')
  })
})
