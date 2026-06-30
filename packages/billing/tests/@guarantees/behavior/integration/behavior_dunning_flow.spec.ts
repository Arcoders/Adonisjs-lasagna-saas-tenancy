import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import emitter from '@adonisjs/core/services/emitter'
import { BillingService } from '@adonisjs-lasagna/billing'
import { MockStripe, signWebhookPayload } from '@adonisjs-lasagna/billing'
import {
  BillingCustomer,
  BillingProcessedEvent,
  BillingSubscription,
} from '@adonisjs-lasagna/billing'
import { PaymentFailed, PaymentSucceeded } from '@adonisjs-lasagna/billing'
import { ProcessBillingEventJob } from '@adonisjs-lasagna/billing'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import {
  setupBillingConfig,
  buildEvent,
  clearBillingTables,
  hydrateJob,
} from '../../../helpers/helpers.js'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'
import { DateTime } from 'luxon'
import type Stripe from 'stripe'

/**
 * Dunning flow drove end-to-end:
 *
 *   POST /webhooks/billing (signed)
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
  let originalDispatch: typeof ProcessBillingEventJob.dispatch
  let mock: MockStripe
  let pendingJobs: string[] = []

  group.each.setup(async () => {
    originalConfig = getConfig()
    setupBillingConfig({ defaultPlan: 'starter' })
    await clearBillingTables()

    mock = new MockStripe('whsec_test_billing_helper')
    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(mock)

    // Capture dispatch calls instead of queueing — the test harness has
    // no BullMQ wiring. We run the job inline at the assertion point so
    // every layer (controller insert + job retrieveEvent + dispatcher)
    // is exercised in order.
    pendingJobs = []
    originalDispatch = ProcessBillingEventJob.dispatch
    ;(
      ProcessBillingEventJob as unknown as {
        dispatch: (p: { eventId: string }) => Promise<void>
      }
    ).dispatch = async (p) => {
      pendingJobs.push(p.eventId)
    }
  })

  group.each.teardown(async () => {
    ;(
      ProcessBillingEventJob as unknown as {
        dispatch: typeof originalDispatch
      }
    ).dispatch = originalDispatch
    await clearBillingTables()
    while (cleanupTenants.length) {
      const id = cleanupTenants.pop()!
      await destroyTestTenant(id).catch(() => {})
    }
    setConfig(originalConfig)
    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()
  })

  /** Run all dispatched jobs inline (drains pendingJobs). */
  async function flushJobs(): Promise<void> {
    while (pendingJobs.length) {
      const eventId = pendingJobs.shift()!
      const job = new ProcessBillingEventJob()
      hydrateJob(job, { eventId })
      await job.execute()
    }
  }

  function buildInvoiceEvent(opts: {
    eventId: string
    customer: string
    subscription: string
    attemptCount: number
    created?: number
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
    return buildEvent('invoice.payment_failed', invoice, {
      id: opts.eventId,
      ...(opts.created ? { created: opts.created } : {}),
    })
  }

  function buildPaymentSucceededEvent(opts: {
    eventId: string
    customer: string
    subscription: string
    created?: number
  }): Stripe.Event {
    const invoice = {
      id: `in_ok_${randomUUID().slice(0, 8)}`,
      object: 'invoice',
      customer: opts.customer,
      amount_paid: 1000,
      currency: 'usd',
      parent: { subscription_details: { subscription: opts.subscription } },
    } as unknown as Stripe.Invoice
    return buildEvent('invoice.payment_succeeded', invoice, {
      id: opts.eventId,
      ...(opts.created ? { created: opts.created } : {}),
    })
  }

  async function postSignedEvent(
    client: { post: (path: string) => any },
    event: Stripe.Event
  ): Promise<void> {
    mock.injectEvent(event)
    const body = JSON.stringify(event)
    const sig = signWebhookPayload(body, 'whsec_test_billing_helper')
    const res = await client
      .post('/webhooks/billing')
      .header('content-type', 'application/json')
      .header('stripe-signature', sig)
      .json(event)
    res.assertStatus(200)
  }

  async function seedActiveSubscription(): Promise<{
    tenantId: string
    providerCustomerId: string
    subId: string
  }> {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const providerCustomerId = `cus_${randomUUID().slice(0, 8)}`
    const cus = new BillingCustomer()
    cus.tenantId = tenant.id
    cus.providerCustomerId = providerCustomerId
    await cus.save()

    const subId = `sub_${randomUUID().slice(0, 8)}`
    const sub = new BillingSubscription()
    sub.providerSubscriptionId = subId
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
    return { tenantId: tenant.id, providerCustomerId, subId }
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
          customer: seed.providerCustomerId,
          subscription: seed.subId,
          attemptCount: 1,
        })
      )
      await postSignedEvent(
        client,
        buildInvoiceEvent({
          eventId: 'evt_dun_2',
          customer: seed.providerCustomerId,
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

      const refreshed = await BillingSubscription.find(seed.subId)
      assert.equal(refreshed?.status, 'active', 'status preserved across non-final retries')

      // Both events were ledger'd exactly once.
      const ledger = await BillingProcessedEvent.query().whereIn('event_id', [
        'evt_dun_1',
        'evt_dun_2',
      ])
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
          customer: seed.providerCustomerId,
          subscription: seed.subId,
          attemptCount: 3, // matches default dunning.maxAttempts
        })
      )
      await flushJobs()

      assert.lengthOf(finals, 1)
      assert.equal(finals[0], 3)

      const refreshed = await BillingSubscription.find(seed.subId)
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
        customer: seed.providerCustomerId,
        subscription: seed.subId,
        attemptCount: 3,
      })
      await postSignedEvent(client, evt)
      await postSignedEvent(client, evt) // same event_id — must collapse
      await flushJobs()

      assert.equal(finalCount, 1, 'final PaymentFailed emitted exactly once')

      const ledger = await BillingProcessedEvent.query().where('event_id', 'evt_dun_dup')
      assert.lengthOf(ledger, 1, 'one ledger row for the duplicated event')
    } finally {
      off()
    }
  })

  test('payment_succeeded after past_due flips status back to active (recovery)', async ({
    assert,
    client,
  }) => {
    // Regression for C-3: customer fixes their card via the billing
    // portal and the next retry succeeds. The local mirror was
    // staying past_due indefinitely until a subscription.updated
    // event happened to arrive — host listeners that gate on
    // status !== 'active' kept blocking a paying tenant.
    const seed = await seedActiveSubscription()
    const succeeded: number[] = []
    const off = emitter.on(PaymentSucceeded, async (e) => {
      succeeded.push(e.payload.amount)
    })

    try {
      // 1. Drive into past_due via final dunning event.
      await postSignedEvent(
        client,
        buildInvoiceEvent({
          eventId: 'evt_recover_fail',
          customer: seed.providerCustomerId,
          subscription: seed.subId,
          attemptCount: 3,
        })
      )
      await flushJobs()
      let mirror = await BillingSubscription.find(seed.subId)
      assert.equal(mirror?.status, 'past_due')

      // 2. Customer pays — payment_succeeded arrives.
      await postSignedEvent(
        client,
        buildPaymentSucceededEvent({
          eventId: 'evt_recover_ok',
          customer: seed.providerCustomerId,
          subscription: seed.subId,
        })
      )
      await flushJobs()

      // 3. Mirror flips back to active automatically.
      mirror = await BillingSubscription.find(seed.subId)
      assert.equal(mirror?.status, 'active', 'recovery flips past_due → active')
      assert.lengthOf(succeeded, 1)
      assert.equal(succeeded[0], 1000)
    } finally {
      off()
    }
  })

  test('payment_succeeded does NOT touch status when subscription is canceled', async ({
    assert,
    client,
  }) => {
    // Final invoice for a canceled subscription must not revive it.
    const seed = await seedActiveSubscription()
    const canceledMirror = await BillingSubscription.find(seed.subId)
    canceledMirror!.status = 'canceled'
    await canceledMirror!.save()

    await postSignedEvent(
      client,
      buildPaymentSucceededEvent({
        eventId: 'evt_late_pay',
        customer: seed.providerCustomerId,
        subscription: seed.subId,
      })
    )
    await flushJobs()

    const refreshed = await BillingSubscription.find(seed.subId)
    assert.equal(refreshed?.status, 'canceled', 'recovery only fires from past_due/unpaid')
  })

  test('stale payment_failed does not overwrite a more recent active status', async ({
    assert,
    client,
  }) => {
    // Regression for S-1 + P-4: out-of-order event delivery where a
    // final payment_failed arrives AFTER a more recent
    // subscription.updated(active). Without the ordering guard, the
    // mirror would silently revert to past_due.
    const seed = await seedActiveSubscription()
    // Bump lastEventAt to "now" so an event with `created = now - 60s`
    // counts as stale (well outside the 5s tolerance).
    const sub = await BillingSubscription.find(seed.subId)
    sub!.lastEventAt = DateTime.utc()
    await sub!.save()

    await postSignedEvent(
      client,
      buildInvoiceEvent({
        eventId: 'evt_stale_fail',
        customer: seed.providerCustomerId,
        subscription: seed.subId,
        attemptCount: 3,
        created: Math.floor(Date.now() / 1000) - 60,
      })
    )
    await flushJobs()

    const refreshed = await BillingSubscription.find(seed.subId)
    assert.equal(
      refreshed?.status,
      'active',
      'stale payment_failed must not flip a fresher active state to past_due'
    )
  })

  test('a provider that reports no attempt count (0) still escalates via the local counter', async ({
    assert,
    client,
  }) => {
    // Lemon Squeezy sends no dunning attempt count (mapper reports 0). The
    // dispatcher's provider-independent counter must still reach maxAttempts.
    const seed = await seedActiveSubscription()
    const captured: Array<{ final: boolean; attempts: number }> = []
    const off = emitter.on(PaymentFailed, async (e) => {
      captured.push({ final: e.payload.final, attempts: e.payload.attempts })
    })

    try {
      for (let i = 1; i <= 3; i++) {
        await postSignedEvent(
          client,
          buildInvoiceEvent({
            eventId: `evt_ls_like_${i}`,
            customer: seed.providerCustomerId,
            subscription: seed.subId,
            attemptCount: 0, // provider reports none
          })
        )
      }
      await flushJobs()

      assert.deepEqual(
        captured.map((c) => c.attempts),
        [1, 2, 3],
        'local counter increments per distinct failure'
      )
      assert.deepEqual(
        captured.map((c) => c.final),
        [false, false, true],
        'final on the 3rd (maxAttempts=3) despite provider attemptCount=0'
      )

      const sub = await BillingSubscription.find(seed.subId)
      assert.equal(sub?.status, 'past_due')
      assert.equal(sub?.dunningAttempts, 3)
    } finally {
      off()
    }
  })

  test('a job retry of the same payment.failed event does NOT double-count (dunningLastEventId guard)', async ({
    assert,
    client,
  }) => {
    const seed = await seedActiveSubscription()
    const evt = buildInvoiceEvent({
      eventId: 'evt_retry_guard',
      customer: seed.providerCustomerId,
      subscription: seed.subId,
      attemptCount: 0,
    })
    await postSignedEvent(client, evt)
    await flushJobs()

    let sub = await BillingSubscription.find(seed.subId)
    assert.equal(sub?.dunningAttempts, 1, 'first processing counts once')

    // Simulate the queue re-running the SAME event (a retry after a transient
    // failure that landed after the dunning write): reset the ledger row to
    // pending and execute the job again. The guard must not re-increment.
    const row = await BillingProcessedEvent.find('evt_retry_guard')
    row!.status = 'pending'
    await row!.save()

    const job = new ProcessBillingEventJob()
    hydrateJob(job, { eventId: 'evt_retry_guard' })
    await job.execute()

    sub = await BillingSubscription.find(seed.subId)
    assert.equal(sub?.dunningAttempts, 1, 'same event id re-processed → counter unchanged')
    assert.equal(sub?.dunningLastEventId, 'evt_retry_guard')
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
          customer: seed.providerCustomerId,
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
