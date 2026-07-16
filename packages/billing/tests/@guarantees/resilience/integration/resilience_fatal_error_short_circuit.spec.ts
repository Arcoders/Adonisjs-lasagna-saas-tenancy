import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import emitter from '@adonisjs/core/services/emitter'
import { BillingService } from '@adonisjs-lasagna/billing'
import { MockStripe, signWebhookPayload } from '@adonisjs-lasagna/billing'
import { BillingProcessedEvent } from '@adonisjs-lasagna/billing'
import { BillingEventDeadLettered } from '@adonisjs-lasagna/billing'
import { ProcessBillingEventJob } from '@adonisjs-lasagna/billing'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import {
  setupBillingConfig,
  buildSubscription,
  buildEvent,
  clearBillingTables,
  hydrateJob,
} from '../../../helpers/helpers.js'
import type Stripe from 'stripe'

/**
 * Covers `ProcessBillingEventJob.#shortCircuitIfFatal`, the fatal-error
 * gate added in the audit. A non-retryable `BillingException`
 * (revoked API key, invalid request, permission denied) must:
 *   - mark the ledger row `status='failed'` immediately
 *   - emit `BillingEventDeadLettered`
 *   - NOT re-throw (so BullMQ doesn't burn its retry budget on something
 *     that can't succeed), leaving `attempts` at 1
 *
 * The contrast case proves a *retryable* error (network blip, 5xx) is
 * NOT short-circuited: the row stays `pending`, the job re-throws so
 * the queue retries, and no dead-letter fires.
 *
 * We make `stripe.events.retrieve` (called by the job's `retrieveEvent`)
 * throw a typed Stripe error so `BillingException.fromStripeError`
 * classifies it. The ledger row is inserted via the real controller
 * POST, so the failure path runs against a genuine row.
 */
test.group('Fatal-error short-circuit (integration)', (group) => {
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
    setConfig(originalConfig)
    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()
  })

  /** POST a signed event through the controller so the ledger row exists. */
  async function seedLedgerViaPost(
    client: { post: (path: string) => any },
    eventId: string
  ): Promise<void> {
    const event = buildEvent('customer.subscription.created', buildSubscription(), { id: eventId })
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

  /** Run the single dispatched job inline; report whether execute() threw. */
  async function runJob(eventId: string): Promise<{ threw: boolean }> {
    const job = new ProcessBillingEventJob()
    hydrateJob(job, { eventId })
    try {
      await job.execute()
      return { threw: false }
    } catch {
      return { threw: true }
    }
  }

  test('a fatal Stripe error marks the row failed, dead-letters, and does NOT retry', async ({
    assert,
    client,
  }) => {
    const eventId = `evt_fatal_${randomUUID().slice(0, 8)}`
    await seedLedgerViaPost(client, eventId)
    assert.lengthOf(pendingJobs, 1)

    // retrieveEvent calls stripe.events.retrieve, which throws an auth error,
    // becoming BillingException('authentication_failed') with isRetryable() === false.
    ;(mock.events as { retrieve: (id: string) => Promise<Stripe.Event> }).retrieve = async () => {
      throw Object.assign(new Error('Invalid API Key provided'), {
        type: 'StripeAuthenticationError',
      })
    }

    const captured: Array<{ errorCode: string; eventId: string }> = []
    const off = emitter.on(BillingEventDeadLettered, async (e) => {
      captured.push({ errorCode: e.payload.errorCode, eventId: e.payload.eventId })
    })

    try {
      const { threw } = await runJob(eventId)
      assert.isFalse(threw, 'fatal short-circuit returns instead of re-throwing — no BullMQ retry')

      const ledger = await BillingProcessedEvent.find(eventId)
      assert.equal(ledger?.status, 'failed')
      assert.equal(ledger?.attempts, 1, 'exactly one attempt — retry budget untouched')
      assert.match(ledger?.lastError ?? '', /Stripe API key was rejected/)

      assert.lengthOf(captured, 1, 'one dead-letter event')
      assert.equal(captured[0].errorCode, 'authentication_failed')
      assert.equal(captured[0].eventId, eventId)
    } finally {
      off()
    }
  })

  test('a retryable Stripe error is NOT short-circuited — row stays pending, job re-throws', async ({
    assert,
    client,
  }) => {
    const eventId = `evt_retryable_${randomUUID().slice(0, 8)}`
    await seedLedgerViaPost(client, eventId)

    // StripeConnectionError becomes BillingException('network_error') with
    // isRetryable() === true.
    ;(mock.events as { retrieve: (id: string) => Promise<Stripe.Event> }).retrieve = async () => {
      throw Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' })
    }

    let deadLettered = 0
    const off = emitter.on(BillingEventDeadLettered, async () => {
      deadLettered += 1
    })

    try {
      const { threw } = await runJob(eventId)
      assert.isTrue(threw, 'retryable error re-throws so BullMQ schedules a retry')

      const ledger = await BillingProcessedEvent.find(eventId)
      assert.equal(
        ledger?.status,
        'pending',
        'still pending — not marked failed on a transient error'
      )
      assert.equal(ledger?.attempts, 1)

      assert.equal(deadLettered, 0, 'no dead-letter while retries remain')
    } finally {
      off()
    }
  })
})
