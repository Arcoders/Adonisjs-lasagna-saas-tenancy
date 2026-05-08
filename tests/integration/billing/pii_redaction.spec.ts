import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { BillingService } from '@adonisjs-lasagna/saas-tenancy/services'
import { MockStripe, signWebhookPayload } from '@adonisjs-lasagna/saas-tenancy/testing'
import {
  StripeCustomer,
  StripeSubscription,
} from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import ProcessStripeEventJob from '../../../src/jobs/process_stripe_event_job.js'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, buildEvent, buildSubscription, clearBillingTables } from './helpers.js'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'
import type Stripe from 'stripe'

/**
 * End-to-end PII redaction check. Patches `process.stdout.write` so we
 * intercept EVERY log emission from Pino regardless of which logger
 * instance produced it. A stub on the imported `logger` would only
 * catch calls that go through that exact reference; this catches the
 * whole stream.
 *
 * Flow exercised:
 *   POST /webhooks/stripe (signed)
 *     → middleware logs (none in happy path; signature mismatch logs)
 *     → controller logs (`stripe.webhook.duplicate` on dups)
 *     → job execute() logs (`stripe.event.processed`)
 *     → job failed() logs (`stripe.event.dead_lettered`) when forced
 *     → dispatcher logs (`stripe.event.stale` for stale events)
 */
test.group('PII redaction (integration)', (group) => {
  const cleanupTenants: string[] = []
  let originalConfig: ReturnType<typeof getConfig>
  let originalStdoutWrite: typeof process.stdout.write
  let originalDispatch: typeof ProcessStripeEventJob.dispatch
  let captured: string[] = []
  let pendingJobs: string[] = []

  group.each.setup(async () => {
    originalConfig = getConfig()
    setupBillingConfig({ defaultPlan: 'starter' })
    await clearBillingTables()

    captured = []
    originalStdoutWrite = process.stdout.write.bind(process.stdout)
    // Intercept stdout — Pino in the fixture is configured with
    // `targets.file({ destination: 1 })`, i.e. raw writes to fd 1. We
    // record the chunk and forward to the original so test runner output
    // still shows up.
    process.stdout.write = ((chunk: unknown, ..._rest: unknown[]) => {
      const s =
        typeof chunk === 'string'
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString('utf8')
            : String(chunk)
      captured.push(s)
      // Forward to the real stdout for visibility in test runner output.
      // Cast through `unknown` because the overload union (string|Buffer)
      // + variadic args is awkward to thread without losing the call.
      return (originalStdoutWrite as (...args: unknown[]) => boolean).apply(process.stdout, [
        chunk,
        ..._rest,
      ])
    }) as typeof process.stdout.write

    pendingJobs = []
    originalDispatch = ProcessStripeEventJob.dispatch
    ;(ProcessStripeEventJob as unknown as {
      dispatch: (p: { eventId: string }) => Promise<void>
    }).dispatch = async (p) => {
      pendingJobs.push(p.eventId)
    }
  })

  group.each.teardown(async () => {
    process.stdout.write = originalStdoutWrite
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

  /** Run any dispatched jobs inline (drains pendingJobs). */
  async function flushJobs(): Promise<void> {
    while (pendingJobs.length) {
      const eventId = pendingJobs.shift()!
      const job = new ProcessStripeEventJob()
      ;(job as unknown as { payload: { eventId: string } }).payload = { eventId }
      await job.execute().catch(() => {})
    }
  }

  test('full webhook flow leaks no PII to stdout (which Pino targets)', async ({
    assert,
    client,
  }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const stripeCustomerId = `cus_${randomUUID().slice(0, 8)}`
    const cus = new StripeCustomer()
    cus.tenantId = tenant.id
    cus.stripeCustomerId = stripeCustomerId
    await cus.save()

    // Pre-existing subscription so the ordering guard's stale branch fires.
    const subId = `sub_${randomUUID().slice(0, 8)}`
    const stale = new StripeSubscription()
    stale.stripeSubscriptionId = subId
    stale.tenantId = tenant.id
    stale.status = 'active'
    stale.currentPeriodStart = DateTime.utc().minus({ days: 1 })
    stale.currentPeriodEnd = DateTime.utc().plus({ days: 29 })
    stale.cancelAtPeriodEnd = false
    stale.cancelAt = null
    stale.canceledAt = null
    stale.trialEnd = null
    stale.planName = 'pro'
    stale.lastEventAt = DateTime.utc()
    stale.raw = {}
    await stale.save()

    const billing = await app.container.make(BillingService)
    const mock = new MockStripe('whsec_test_billing_helper')
    billing.__setStripeForTests(mock)

    // Hostile event payload — every PII landmine. The redacted output
    // should land in stripe_processed_events.payload AND in the logs
    // without these fields.
    const sub = buildSubscription({
      id: subId,
      customer: stripeCustomerId,
      productId: 'prod_pro',
    })
    const hostile = buildEvent(
      'customer.subscription.updated',
      {
        ...sub,
        billing_details: { email: 'user@example.com', name: 'Jane Doe', phone: '+1-555' },
        payment_method: { card: { last4: '4242', brand: 'visa' } },
        receipt_number: 'shhh-receipt',
        metadata: { internal_secret: 'TOP-SECRET-DATA' },
      } as unknown as Stripe.Subscription,
      { id: 'evt_pii_check' }
    )
    // Make the event stale so the dispatcher's stale-warn log fires too.
    hostile.created = Math.floor(stale.lastEventAt.toSeconds()) - 30
    mock.injectEvent(hostile)

    const body = JSON.stringify(hostile)
    const sig = signWebhookPayload(body, 'whsec_test_billing_helper')
    const res = await client
      .post('/webhooks/stripe')
      .header('content-type', 'application/json')
      .header('stripe-signature', sig)
      .json(hostile)
    res.assertStatus(200)

    await flushJobs()

    // Concatenate every captured stdout chunk. Pino emits one JSON line
    // per log call.
    const blob = captured.join('')
    const FORBIDDEN = [
      'user@example.com',
      'Jane Doe',
      '+1-555',
      '4242',
      'shhh-receipt',
      'billing_details',
      'payment_method',
      'TOP-SECRET-DATA',
    ]
    for (const needle of FORBIDDEN) {
      assert.notInclude(blob, needle, `stdout leaked "${needle}"`)
    }

    // Sanity: at least ONE expected billing log fired so we know the
    // capture is wired (otherwise the assertions above are vacuous).
    const sawBillingLog =
      blob.includes('stripe.event') ||
      blob.includes('stripe.webhook')
    assert.isTrue(sawBillingLog, 'at least one billing log line captured to stdout')
  })

  test('failed() event payload uses errorCode, not raw error.message', async ({ assert }) => {
    // Force the job to fail on retrieveEvent — the mock without an
    // injectEvent throws "No event evt_xxx (use mock.injectEvent first)".
    // This message is from the mock itself, not Stripe SDK, so it's safe
    // to assert on — we only want to confirm classifyError() routes it
    // to `unhandled_error` and does NOT leak the raw message.
    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    // Seed a ledger row directly (skip the controller).
    const eventId = 'evt_failed_classify'
    const row = new (
      await import('@adonisjs-lasagna/saas-tenancy/models/satellites')
    ).StripeProcessedEvent()
    row.eventId = eventId
    row.eventType = 'customer.subscription.created'
    row.status = 'pending'
    row.attempts = 0
    row.payload = null
    await row.save()

    const job = new ProcessStripeEventJob()
    ;(job as unknown as { payload: { eventId: string } }).payload = { eventId }

    let thrown: unknown
    try {
      await job.execute()
    } catch (err) {
      thrown = err
    }
    assert.isDefined(thrown, 'execute should propagate the retrieve error')

    // The actual `failed()` is called by BullMQ; we invoke it directly to
    // exercise the redaction path.
    await job.failed(thrown as Error)

    // Reload the row — last_error should be `unhandled_error` (or the
    // BillingException code if the failure was wrapped). Critical: it
    // must NOT contain "use mock.injectEvent first" (raw error message).
    const updated = await (
      await import('@adonisjs-lasagna/saas-tenancy/models/satellites')
    ).StripeProcessedEvent.find(eventId)
    assert.isNotNull(updated)
    assert.notInclude(updated?.lastError ?? '', 'mock.injectEvent')
    assert.equal(updated?.status, 'failed')
  })
})
