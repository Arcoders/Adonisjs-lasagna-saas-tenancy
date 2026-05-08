import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import emitter from '@adonisjs/core/services/emitter'
import { BillingService } from '@adonisjs-lasagna/saas-tenancy/services'
import { MockStripe } from '@adonisjs-lasagna/saas-tenancy/testing'
import {
  StripeCustomer,
  StripeSubscription,
} from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { PaymentFailed } from '@adonisjs-lasagna/saas-tenancy/events'
import { dispatchStripeEvent } from '../../../src/services/billing/stripe_event_dispatcher.js'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, buildEvent, buildSubscription, clearBillingTables } from './helpers.js'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'
import type Stripe from 'stripe'

/**
 * Dunning flow:
 *   - 1st & 2nd payment_failed → emit `PaymentFailed { final: false }`,
 *     no status change.
 *   - 3rd payment_failed (≥ maxAttempts) → mark `stripe_subscriptions.status='past_due'`,
 *     emit `PaymentFailed { final: true }`.
 *
 * Drives the dispatcher directly (not the queue) so we don't depend on
 * BullMQ wiring in the test harness.
 */
test.group('Dunning state machine (integration)', (group) => {
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

  function buildInvoiceEvent(
    overrides: Partial<{ id: string; customer: string; subscription: string; attemptCount: number }>
  ) {
    const invoice = {
      id: overrides.id ?? `in_${randomUUID().slice(0, 8)}`,
      object: 'invoice',
      customer: overrides.customer ?? 'cus_x',
      amount_due: 1000,
      currency: 'usd',
      attempt_count: overrides.attemptCount ?? 1,
      // Stripe v18 nests the subscription ref:
      parent: { subscription_details: { subscription: overrides.subscription ?? null } },
    } as unknown as Stripe.Invoice
    return buildEvent('invoice.payment_failed', invoice)
  }

  test('first 2 failures emit PaymentFailed{final:false}, status unchanged', async ({
    assert,
  }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const stripeCustomerId = `cus_${randomUUID().slice(0, 8)}`
    const cus = new StripeCustomer()
    cus.tenantId = tenant.id
    cus.stripeCustomerId = stripeCustomerId
    await cus.save()

    // Pre-existing active subscription.
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

    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const captured: Array<{ final: boolean; attempts: number }> = []
    const off = emitter.on(PaymentFailed, async (e) => {
      captured.push({ final: e.payload.final, attempts: e.payload.attempts })
    })

    try {
      // First retry: attempt_count=1
      await dispatchStripeEvent(
        buildInvoiceEvent({ customer: stripeCustomerId, subscription: subId, attemptCount: 1 }),
        { billing, logger }
      )
      // Second retry: attempt_count=2
      await dispatchStripeEvent(
        buildInvoiceEvent({ customer: stripeCustomerId, subscription: subId, attemptCount: 2 }),
        { billing, logger }
      )

      assert.lengthOf(captured, 2)
      assert.isFalse(captured[0].final, 'attempt 1 is not final')
      assert.isFalse(captured[1].final, 'attempt 2 is not final')

      const refreshed = await StripeSubscription.find(subId)
      assert.equal(refreshed?.status, 'active', 'status preserved during dunning warmup')
    } finally {
      off()
    }
  })

  test('3rd failure (>=maxAttempts) flips status=past_due and final=true', async ({
    assert,
  }) => {
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

    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const finalEvents: number[] = []
    const off = emitter.on(PaymentFailed, async (e) => {
      if (e.payload.final) finalEvents.push(e.payload.attempts)
    })

    try {
      // attempt_count=3 ≥ default maxAttempts(3)
      await dispatchStripeEvent(
        buildInvoiceEvent({ customer: stripeCustomerId, subscription: subId, attemptCount: 3 }),
        { billing, logger }
      )

      assert.lengthOf(finalEvents, 1, 'final PaymentFailed emitted exactly once')
      assert.equal(finalEvents[0], 3)

      const refreshed = await StripeSubscription.find(subId)
      assert.equal(refreshed?.status, 'past_due', 'subscription escalated to past_due')
    } finally {
      off()
    }
  })

  test('honours custom maxAttempts from config.billing.dunning', async ({ assert }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const stripeCustomerId = `cus_${randomUUID().slice(0, 8)}`
    const cus = new StripeCustomer()
    cus.tenantId = tenant.id
    cus.stripeCustomerId = stripeCustomerId
    await cus.save()

    // Lower maxAttempts to 1 — the very first failure is "final".
    const cfg = getConfig()
    setConfig({
      ...cfg,
      billing: {
        ...cfg.billing!,
        dunning: { maxAttempts: 1 },
      },
    } as never)

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

    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    let final = false
    const off = emitter.on(PaymentFailed, async (e) => {
      if (e.payload.final) final = true
    })

    try {
      await dispatchStripeEvent(
        buildInvoiceEvent({ customer: stripeCustomerId, subscription: subId, attemptCount: 1 }),
        { billing, logger }
      )
      assert.isTrue(final, 'maxAttempts=1 ⇒ first failure is final')
    } finally {
      off()
    }
  })
})
