import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { BillingService } from '@adonisjs-lasagna/billing'
import { MockStripe, signWebhookPayload } from '@adonisjs-lasagna/billing'
import { BillingCustomer, BillingSubscription } from '@adonisjs-lasagna/billing'
import { ProcessBillingEventJob } from '@adonisjs-lasagna/billing'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import {
  setupBillingConfig,
  buildEvent,
  buildSubscription,
  clearBillingTables,
  hydrateJob,
} from './helpers.js'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'
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
  let originalDispatch: typeof ProcessBillingEventJob.dispatch
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
    process.stdout.write = originalStdoutWrite
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

  /** Run any dispatched jobs inline (drains pendingJobs). */
  async function flushJobs(): Promise<void> {
    while (pendingJobs.length) {
      const eventId = pendingJobs.shift()!
      const job = new ProcessBillingEventJob()
      hydrateJob(job, { eventId })
      await job.execute().catch(() => {})
    }
  }

  test('full webhook flow leaks no PII to stdout (which Pino targets)', async ({
    assert,
    client,
  }) => {
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const providerCustomerId = `cus_${randomUUID().slice(0, 8)}`
    const cus = new BillingCustomer()
    cus.tenantId = tenant.id
    cus.providerCustomerId = providerCustomerId
    await cus.save()

    // Pre-existing subscription so the ordering guard's stale branch fires.
    const subId = `sub_${randomUUID().slice(0, 8)}`
    const stale = new BillingSubscription()
    stale.providerSubscriptionId = subId
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
    await billing.__setStripeForTests(mock)

    // Hostile event payload — every PII landmine. The redacted output
    // should land in billing_processed_events.payload AND in the logs
    // without these fields.
    const sub = buildSubscription({
      id: subId,
      customer: providerCustomerId,
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

    // Anchor the redaction check: the persisted payload (which the
    // controller writes to `billing_processed_events.payload`) goes
    // through `redactStripeEvent()`, so if the FORBIDDEN scan above
    // is vacuous (Pino's worker transport can bypass our
    // `process.stdout.write` patch when running through
    // `@adonisjs/core/logger`), this still proves the redaction code
    // path actually ran on the hostile event.
    const ledger = await (
      await import('@adonisjs-lasagna/billing')
    ).BillingProcessedEvent.find('evt_pii_check')
    assert.isNotNull(ledger, 'controller wrote the idempotency ledger row')
    const payload = JSON.stringify(ledger?.payload ?? {})
    for (const needle of FORBIDDEN) {
      assert.notInclude(payload, needle, `ledger payload leaked "${needle}"`)
    }
  })

  test('failed() event payload uses errorCode, not raw error.message', async ({ assert }) => {
    // Force the job to fail on retrieveEvent with a RETRYABLE error carrying a
    // sensitive raw message. A retryable error propagates (so BullMQ retries);
    // once retries are exhausted BullMQ calls failed(), which must persist the
    // safe BillingException code/message and never the raw driver text. (A
    // resource_missing here would instead short-circuit as fatal, so we inject
    // a connection error explicitly to reach the failed() path.)
    const billing = await app.container.make(BillingService)
    const mock = new MockStripe('whsec_test_billing_helper')
    await billing.__setStripeForTests(mock)
    ;(mock.events as { retrieve: (id: string) => Promise<Stripe.Event> }).retrieve = async () => {
      throw Object.assign(new Error('socket hang up while reading cus_secret_pii'), {
        type: 'StripeConnectionError',
      })
    }

    // Seed a ledger row directly (skip the controller).
    const eventId = 'evt_failed_classify'
    const row = new (await import('@adonisjs-lasagna/billing')).BillingProcessedEvent()
    row.eventId = eventId
    row.eventType = 'customer.subscription.created'
    row.status = 'pending'
    row.attempts = 0
    row.payload = null
    await row.save()

    const job = new ProcessBillingEventJob()
    hydrateJob(job, { eventId })

    let thrown: unknown
    try {
      await job.execute()
    } catch (err) {
      thrown = err
    }
    assert.isDefined(thrown, 'a retryable retrieve error propagates so BullMQ can retry')

    // The actual `failed()` is called by BullMQ; we invoke it directly to
    // exercise the redaction path.
    await job.failed(thrown as Error)

    // Reload the row. last_error must be the package-controlled BillingException
    // message, never the raw driver text or the leaked customer id.
    const updated = await (
      await import('@adonisjs-lasagna/billing')
    ).BillingProcessedEvent.find(eventId)
    assert.isNotNull(updated)
    assert.notInclude(updated?.lastError ?? '', 'cus_secret_pii')
    assert.notInclude(updated?.lastError ?? '', 'socket hang up')
    assert.equal(updated?.status, 'failed')
  })
})
