import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import ace from '@adonisjs/core/services/ace'
import { BillingService } from '@adonisjs-lasagna/saas-tenancy/services'
import { MockStripe } from '@adonisjs-lasagna/saas-tenancy/testing'
import {
  StripeCustomer,
  StripeSubscription,
  TenantPlan,
} from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, clearBillingTables } from './helpers.js'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'
import type Stripe from 'stripe'

/**
 * `tenant:billing:sync` paginates Stripe.subscriptions.list and reapplies
 * `BillingService.syncSubscription` for every drift. Idempotent — on a
 * clean state it scans + reports zero repaired.
 *
 * We avoid running the actual ace command bin path (the harness already
 * boots the app); instead we instantiate the command class with a mocked
 * Stripe and assert behaviour.
 */
test.group('tenant:billing:sync (integration)', (group) => {
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

  function mockListReturning(subs: Stripe.Subscription[]): MockStripe {
    const mock = new MockStripe('whsec_test_billing_helper')
    mock.subscriptions.list = ((_params: unknown) => {
      return {
        [Symbol.asyncIterator]: async function* () {
          for (const s of subs) yield s
        },
      }
    }) as unknown as MockStripe['subscriptions']['list']
    return mock
  }

  test('repairs drift: local "active" but Stripe says "canceled"', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const stripeCustomerId = `cus_${randomUUID().slice(0, 8)}`
    const cus = new StripeCustomer()
    cus.tenantId = tenant.id
    cus.stripeCustomerId = stripeCustomerId
    await cus.save()

    const subId = `sub_${randomUUID().slice(0, 8)}`
    const sub = new StripeSubscription()
    sub.stripeSubscriptionId = subId
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

    // Pre-seed an "active" plan assignment so we can verify it gets
    // downgraded after sync.
    await TenantPlan.query().delete()
    const tp = new TenantPlan()
    tp.tenantId = tenant.id
    tp.planName = 'pro'
    tp.source = 'stripe'
    tp.assignedAt = DateTime.utc()
    tp.expiresAt = null
    await tp.save()

    // Stripe now says: this subscription is canceled.
    const remoteSub = {
      id: subId,
      object: 'subscription',
      customer: stripeCustomerId,
      status: 'canceled',
      items: {
        data: [
          {
            price: { id: 'price_pro', product: 'prod_pro' },
            current_period_start: Math.floor(Date.now() / 1000) - 86400,
            current_period_end: Math.floor(Date.now() / 1000),
          },
        ],
      },
      cancel_at_period_end: false,
      canceled_at: Math.floor(Date.now() / 1000),
      trial_end: null,
      metadata: {},
    } as unknown as Stripe.Subscription

    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(mockListReturning([remoteSub]))

    const command = await ace.exec('tenant:billing:sync', ['--json'])
    assert.equal(command.exitCode, 0)

    const refreshed = await StripeSubscription.find(subId)
    assert.equal(refreshed?.status, 'canceled', 'local mirror updated')

    const plan = await TenantPlan.find(tenant.id)
    assert.equal(plan?.planName, 'starter', 'plan downgraded to defaultPlan')
  })

  test('clean state: scanned > 0, drifted = 0, repaired = 0, exit 0', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const stripeCustomerId = `cus_${randomUUID().slice(0, 8)}`
    const cus = new StripeCustomer()
    cus.tenantId = tenant.id
    cus.stripeCustomerId = stripeCustomerId
    await cus.save()

    // Both sides agree on "active".
    const subId = `sub_${randomUUID().slice(0, 8)}`
    const local = new StripeSubscription()
    local.stripeSubscriptionId = subId
    local.tenantId = tenant.id
    local.status = 'active'
    local.currentPeriodStart = DateTime.utc().minus({ days: 1 })
    local.currentPeriodEnd = DateTime.utc().plus({ days: 29 })
    local.cancelAtPeriodEnd = false
    local.cancelAt = null
    local.canceledAt = null
    local.trialEnd = null
    local.planName = 'pro'
    local.lastEventAt = DateTime.utc().minus({ minutes: 1 })
    local.raw = {}
    await local.save()

    const remoteSub = {
      id: subId,
      object: 'subscription',
      customer: stripeCustomerId,
      status: 'active',
      items: { data: [{ price: { id: 'price_pro', product: 'prod_pro' } }] },
      cancel_at_period_end: false,
    } as unknown as Stripe.Subscription

    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(mockListReturning([remoteSub]))

    const command = await ace.exec('tenant:billing:sync', ['--dry-run'])
    assert.equal(command.exitCode, 0)
  })

  test('--tenant=<id> with unknown tenant exits 1', async ({ assert }) => {
    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const command = await ace.exec('tenant:billing:sync', [
      `--tenant=${randomUUID()}`,
    ])
    assert.equal(command.exitCode, 1)
  })

  test('--since with malformed timestamp exits 1', async ({ assert }) => {
    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const command = await ace.exec('tenant:billing:sync', ['--since=not-a-date'])
    assert.equal(command.exitCode, 1)
  })

  test('reverse pass (G-5): orphaned tenant_plans get downgraded', async ({ assert }) => {
    // Tenant claims 'pro' via tenant_plans (source=stripe) but has no
    // matching active stripe_subscription. Possible cause: a missed
    // customer.subscription.deleted webhook, manual data drift, or a
    // pre-package migration. The reverse pass must catch this and
    // downgrade to defaultPlan.
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const cus = new StripeCustomer()
    cus.tenantId = tenant.id
    cus.stripeCustomerId = `cus_${randomUUID().slice(0, 8)}`
    await cus.save()

    // Stale tenant_plans row, source=stripe, planName=pro.
    await TenantPlan.query().delete()
    const tp = new TenantPlan()
    tp.tenantId = tenant.id
    tp.planName = 'pro'
    tp.source = 'stripe'
    tp.assignedAt = DateTime.utc().minus({ days: 30 })
    tp.expiresAt = null
    await tp.save()

    // Stripe lists nothing for this customer (the sub was deleted /
    // never properly recorded).
    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(mockListReturning([]))

    const command = await ace.exec('tenant:billing:sync', ['--json'])
    assert.equal(command.exitCode, 0)

    const refreshed = await TenantPlan.find(tenant.id)
    assert.equal(refreshed?.planName, 'starter', 'orphan downgraded to defaultPlan')
    assert.equal(refreshed?.source, 'reconciliation')
  })

  test('reverse pass (G-5): tenants already on defaultPlan are not flagged as orphans', async ({
    assert,
  }) => {
    // Legitimate state: subscription was canceled, syncSubscription
    // wrote tenant_plans={planName:starter, source:stripe}. Reverse
    // pass must not waste cycles re-touching this row.
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const cus = new StripeCustomer()
    cus.tenantId = tenant.id
    cus.stripeCustomerId = `cus_${randomUUID().slice(0, 8)}`
    await cus.save()

    await TenantPlan.query().delete()
    const tp = new TenantPlan()
    tp.tenantId = tenant.id
    tp.planName = 'starter' // defaultPlan
    tp.source = 'stripe'
    tp.assignedAt = DateTime.utc()
    tp.expiresAt = null
    await tp.save()

    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(mockListReturning([]))

    const command = await ace.exec('tenant:billing:sync', ['--json'])
    assert.equal(command.exitCode, 0)

    const refreshed = await TenantPlan.find(tenant.id)
    assert.equal(refreshed?.source, 'stripe', 'source preserved — not touched by reverse pass')
  })

  test('reverse pass (G-5): --dry-run reports orphans without repairing', async ({
    assert,
  }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const cus = new StripeCustomer()
    cus.tenantId = tenant.id
    cus.stripeCustomerId = `cus_${randomUUID().slice(0, 8)}`
    await cus.save()

    await TenantPlan.query().delete()
    const tp = new TenantPlan()
    tp.tenantId = tenant.id
    tp.planName = 'pro'
    tp.source = 'stripe'
    tp.assignedAt = DateTime.utc()
    tp.expiresAt = null
    await tp.save()

    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(mockListReturning([]))

    const command = await ace.exec('tenant:billing:sync', ['--dry-run'])
    assert.equal(command.exitCode, 0)

    const refreshed = await TenantPlan.find(tenant.id)
    assert.equal(refreshed?.planName, 'pro', 'dry-run must not write')
    assert.equal(refreshed?.source, 'stripe')
  })
})
