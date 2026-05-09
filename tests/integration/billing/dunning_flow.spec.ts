import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import emitter from '@adonisjs/core/services/emitter'
import { BillingService } from '@adonisjs-lasagna/saas-tenancy/services'
import { MockStripe, signWebhookPayload } from '@adonisjs-lasagna/saas-tenancy/testing'
import {
  StripeCustomer,
  StripeProcessedEvent,
  StripeSubscription,
} from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { PaymentFailed } from '@adonisjs-lasagna/saas-tenancy/events'
import { ProcessStripeEventJob } from '@adonisjs-lasagna/saas-tenancy/jobs'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, buildEvent, clearBillingTables, hydrateJob } from './helpers.js'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'
import { DateTime } from 'luxon'
import type Stripe from 'stripe'

/**
 * Dunning flow drove end-to-end:
 *
 *   POST /webhooks/stripe (signed)
 *     → middleware verifies signature
 *     → controller writes idempotency row + dispatches the job
 *     → job (executed inline below) calls retrieveEvent() and dispatcher
 *     → dispatcher logic flips status / emits PaymentFailed
 *
 * Calling `dispatchStripeEvent` directly would skip the controller and
 * the job's retrieveEvent re-fetch — both load-bearing in production.
 * Here we still execute the job inline (no BullMQ in tests) but go
 * through every other layer.
 */
test.group('Dunning state machine (integration)', (group) => {
  const cleanupTenants: string[] = []
  let originalConfig: ReturnType<typeof getConfig>
  let originalDispatch: typeof ProcessStripeEventJob.dispatch
  let mock: MockStripe
  let pendingJobs: string[] = []

  group.each.setup(async () => {
    originalConfig = getConfig()
    setupBillingConfig({ defaultPlan: 'starter' })
    await clearBillingTables()

    mock = new MockStripe('whsec_test_billing_helper')
    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(mock)

    // Capture dispatch calls instead of queueing — the test harness has
    // no BullMQ wiring. We run the job inline at the assertion point so
    // every layer (controller insert + job retrieveEvent + dispatcher)
    // is exercised in order.
    pendingJobs = []
    originalDispatch = ProcessStripeEventJob.dispatch
    ;(ProcessStripeEventJob as unknown as {
      dispatch: (p: { eventId: string }) => Promise<void>
    }).dispatch = async (p) => {
      pendingJobs.push(p.eventId)
    }
  })

  group.each.teardown(async () => {
    ;(ProcessStripeEventJob as unknown as {
      dispatch: typeof originalDispatch
    }).dispatch = originalDispatch
    await clearBillingTables()
    while (cleanupTenants.length) {
      const id = cleanupTenants.pop()!
      await destroyTestTenant(id).catch(() => {})
    }
    setConfig(originalConfig)
    const billing = await app.container.make(BillingService)
    billing.__resetForTests()
  })

  /** Run all dispatched jobs inline (drains pendingJobs). */
  async function flushJobs(): Promise<void> {
    while (pendingJobs.length) {
      const eventId = pendingJobs.shift()!
      const job = new ProcessStripeEventJob()
      hydrateJob(job, { eventId })
      await job.execute()
    }
  }

  function buildInvoiceEvent(opts: {
    eventId: string
    customer: string
    subscription: string
    attemptCount: number
  }): Stripe.Event {
    const invoice = {
      id: `in_${randomUUID().slice(0, 8)}`,
      object: 'invoice',
      customer: opts.customer,
      amount_due: 1000,
      currency: 'usd',
      attempt_count: opts.attemptCount,
      parent: { subscription_details: { subscription: opts.subscription } },
    } as unknown as Stripe.Invoice
    return buildEvent('invoice.payment_failed', invoice, { id: opts.eventId })
  }

  async function postSignedEvent(
    client: { post: (path: string) => any },
    event: Stripe.Event
  ): Promise<void> {
    mock.injectEvent(event)
    const body = JSON.stringify(event)
    const sig = signWebhookPayload(body, 'whsec_test_billing_helper')
    const res = await client
      .post('/webhooks/stripe')
      .header('content-type', 'application/json')
      .header('stripe-signature', sig)
      .json(event)
    res.assertStatus(200)
  }

  async function seedActiveSubscription(): Promise<{ tenantId: string; stripeCustomerId: string; subId: string }> {
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
    return { tenantId: tenant.id, stripeCustomerId, subId }
  }

  test('attempts 1 and 2 emit PaymentFailed{final:false} and status stays active', async ({
    assert,
    client,
  }) => {
    const seed = await seedActiveSubscription()
    const captured: Array<{ final: boolean; attempts: number }> = []
    const off = emitter.on(PaymentFailed, async (e) => {
      captured.push({ final: e.payload.final, attempts: e.payload.attempts })
    })

    try {
      await postSignedEvent(
        client,
        buildInvoiceEvent({
          eventId: 'evt_dun_1',
          customer: seed.stripeCustomerId,
          subscription: seed.subId,
          attemptCount: 1,
        })
      )
      await postSignedEvent(
        client,
        buildInvoiceEvent({
          eventId: 'evt_dun_2',
          customer: seed.stripeCustomerId,
          subscription: seed.subId,
          attemptCount: 2,
        })
      )
      await flushJobs()

      assert.lengthOf(captured, 2)
      assert.isFalse(captured[0].final)
      assert.isFalse(captured[1].final)
      assert.equal(captured[0].attempts, 1)
      assert.equal(captured[1].attempts, 2)

      const refreshed = await StripeSubscription.find(seed.subId)
      assert.equal(refreshed?.status, 'active', 'status preserved across non-final retries')

      // Both events were ledger'd exactly once.
      const ledger = await StripeProcessedEvent.query().whereIn(
        'event_id',
        ['evt_dun_1', 'evt_dun_2']
      )
      assert.lengthOf(ledger, 2)
    } finally {
      off()
    }
  })

  test('attempt 3 (>=maxAttempts) flips status=past_due and final=true', async ({
    assert,
    client,
  }) => {
    const seed = await seedActiveSubscription()
    const finals: number[] = []
    const off = emitter.on(PaymentFailed, async (e) => {
      if (e.payload.final) finals.push(e.payload.attempts)
    })

    try {
      await postSignedEvent(
        client,
        buildInvoiceEvent({
          eventId: 'evt_dun_final',
          customer: seed.stripeCustomerId,
          subscription: seed.subId,
          attemptCount: 3, // matches default dunning.maxAttempts
        })
      )
      await flushJobs()

      assert.lengthOf(finals, 1)
      assert.equal(finals[0], 3)

      const refreshed = await StripeSubscription.find(seed.subId)
      assert.equal(refreshed?.status, 'past_due')
    } finally {
      off()
    }
  })

  test('duplicate POST of the final dunning event does NOT double-flip / double-emit', async ({
    assert,
    client,
  }) => {
    const seed = await seedActiveSubscription()
    let finalCount = 0
    const off = emitter.on(PaymentFailed, async (e) => {
      if (e.payload.final) finalCount += 1
    })

    try {
      const evt = buildInvoiceEvent({
        eventId: 'evt_dun_dup',
        customer: seed.stripeCustomerId,
        subscription: seed.subId,
        attemptCount: 3,
      })
      await postSignedEvent(client, evt)
      await postSignedEvent(client, evt) // same event_id — must collapse
      await flushJobs()

      assert.equal(finalCount, 1, 'final PaymentFailed emitted exactly once')

      const ledger = await StripeProcessedEvent.query().where('event_id', 'evt_dun_dup')
      assert.lengthOf(ledger, 1, 'one ledger row for the duplicated event')
    } finally {
      off()
    }
  })

  test('honours custom maxAttempts from config.billing.dunning', async ({ assert, client }) => {
    const seed = await seedActiveSubscription()
    const cfg = getConfig()
    setConfig({
      ...cfg,
      billing: { ...cfg.billing!, dunning: { maxAttempts: 1 } },
    } as never)

    let final = false
    const off = emitter.on(PaymentFailed, async (e) => {
      if (e.payload.final) final = true
    })

    try {
      await postSignedEvent(
        client,
        buildInvoiceEvent({
          eventId: 'evt_dun_custom',
          customer: seed.stripeCustomerId,
          subscription: seed.subId,
          attemptCount: 1,
        })
      )
      await flushJobs()
      assert.isTrue(final, 'maxAttempts=1 ⇒ first failure is final')
    } finally {
      off()
    }
  })
})
