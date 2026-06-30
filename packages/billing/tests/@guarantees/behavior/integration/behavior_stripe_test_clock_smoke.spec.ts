import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import { randomUUID } from 'node:crypto'
import emitter from '@adonisjs/core/services/emitter'
import { BillingService, signWebhookPayload } from '@adonisjs-lasagna/billing'
import { TenantPlan } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import {
  BillingCustomer,
  BillingSubscription,
  BillingProcessedEvent,
  PaymentFailed,
} from '@adonisjs-lasagna/billing'
import { ProcessBillingEventJob } from '@adonisjs-lasagna/billing'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { testConfig } from '@adonisjs-lasagna/satellite-test-kit/testing'
import { clearBillingTables, hydrateJob } from '../../../helpers/helpers.js'
import { isInfraError, StripeInfraUnavailable } from '../../../helpers/smoke_error.js'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'
import type { ApiClient } from '@japa/api-client'
import type Stripe from 'stripe'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Layer 3 — real billing cycle via Stripe Test Clocks. The one thing the
 * hand-built event fixtures can't exercise is the passage of time: renewals,
 * period advance, and a failed renewal that drives dunning. Test Clocks let us
 * simulate a month in seconds against the real Stripe test API, then replay the
 * events Stripe generates through our own signed-webhook pipeline (the same
 * replay path as stripe_real_smoke.spec.ts).
 *
 * Skipped unless STRIPE_TEST_API_KEY (sk_test_*) is set. Cleanup is best-effort;
 * deleting the test clock cascades to its customers/subscriptions.
 */
const REAL_KEY = process.env.STRIPE_TEST_API_KEY
const SHOULD_RUN = typeof REAL_KEY === 'string' && REAL_KEY.startsWith('sk_test_')

const SOURCE_META = { source: 'lasagna-saas-tenancy-smoke-test' }

/** Poll events.list until an event matching `predicate` surfaces (or deadline). */
async function pullEvent(
  stripe: Stripe,
  sinceTs: number,
  predicate: (e: Stripe.Event) => boolean,
  deadlineMs = 20_000
): Promise<Stripe.Event | null> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const list = await stripe.events.list({ created: { gte: sinceTs }, limit: 100 })
    const found = list.data.find(predicate)
    if (found) return found
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

/** Advancing a clock is async — poll until it reports `ready`. */
async function waitForClockReady(
  stripe: Stripe,
  clockId: string,
  deadlineMs = 60_000
): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const clock = await stripe.testHelpers.testClocks.retrieve(clockId)
    if (clock.status === 'ready') return
    if (clock.status === 'internal_failure') {
      throw new StripeInfraUnavailable('test clock advance reported internal_failure')
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
  throw new StripeInfraUnavailable('test clock did not become ready within the deadline')
}

/**
 * Soft-skip: a Stripe-side infrastructure failure (test clock wedged, API
 * unavailable, an event that never surfaced within the deadline) must not fail
 * an unrelated PR. We log loudly and return early from the test; the real
 * lifecycle assertions only run once the infra cooperated, so genuine
 * renewal/dunning regressions still fail the build.
 */
function softSkip(reason: string, err?: unknown): void {
  logger.warn(
    { err: err instanceof Error ? err.message : err },
    `stripe_test_clock_smoke: ${reason} — Stripe-side infra (check status.stripe.com); soft-skipping`
  )
}

test.group('Stripe Test Clocks — real billing cycle', (group) => {
  const cleanupTenants: string[] = []
  let originalConfig: ReturnType<typeof getConfig>
  let originalDispatch: typeof ProcessBillingEventJob.dispatch
  let pendingJobs: string[] = []

  group.each.setup(async () => {
    originalConfig = getConfig()
    pendingJobs = []
    originalDispatch = ProcessBillingEventJob.dispatch
    ;(
      ProcessBillingEventJob as unknown as {
        dispatch: (payload: { eventId: string }) => Promise<void>
      }
    ).dispatch = async (p) => {
      pendingJobs.push(p.eventId)
    }
    await clearBillingTables()
  })

  group.each.teardown(async () => {
    ;(ProcessBillingEventJob as unknown as { dispatch: typeof originalDispatch }).dispatch =
      originalDispatch
    await clearBillingTables()
    while (cleanupTenants.length) {
      const id = cleanupTenants.pop()!
      await destroyTestTenant(id).catch(() => {})
    }
    setConfig(originalConfig)
    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()
  })

  /** Drain dispatched jobs inline (no BullMQ in tests). */
  async function flushJobs(): Promise<void> {
    while (pendingJobs.length) {
      const eventId = pendingJobs.shift()!
      const job = new ProcessBillingEventJob()
      hydrateJob(job, { eventId })
      await job.execute()
    }
  }

  /** Sign + POST an event through the real webhook route, then run the job. */
  async function replay(client: ApiClient, event: Stripe.Event, secret: string): Promise<void> {
    const body = JSON.stringify(event)
    const sig = signWebhookPayload(body, secret)
    const res = await client
      .post('/webhooks/billing')
      .header('content-type', 'application/json')
      .header('stripe-signature', sig)
      .json(event as never)
    res.assertStatus(200)
    await flushJobs()
  }

  function configure(webhookSecret: string): void {
    setConfig({
      ...testConfig,
      plans: {
        defaultPlan: 'starter',
        definitions: {
          starter: { limits: { apiRequests: 100 } },
          smoke_pro: { limits: { apiRequests: 10_000 } },
        },
        storage: 'tenant_plans',
      },
      billing: {
        driver: 'stripe',
        stripe: { apiKey: REAL_KEY!, webhookSecret },
        products: {}, // filled once the product exists
        defaultPlan: 'starter',
      },
    } as never)
  }

  /**
   * Provision a clock + product/price + a clock-bound customer (with the local
   * mirror row the webhook lookup needs) + an active subscription paid by
   * `pm_card_visa`. Returns the ids and the Stripe `customer`/`subscription`.
   */
  async function provisionOnClock(
    stripe: Stripe,
    runId: string
  ): Promise<{
    clockId: string
    productId: string
    priceId: string
    tenantId: string
    customerId: string
    subscriptionId: string
  }> {
    const nowSec = Math.floor(Date.now() / 1000)
    const clock = await stripe.testHelpers.testClocks.create({
      frozen_time: nowSec,
      name: `lasagna smoke ${runId}`,
    })

    const product = await stripe.products.create({
      name: `Lasagna clock ${runId}`,
      metadata: { ...SOURCE_META, run_id: runId },
    })
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: 1000,
      currency: 'usd',
      recurring: { interval: 'month' },
      metadata: { ...SOURCE_META, run_id: runId },
    })
    setConfig({
      ...getConfig(),
      billing: { ...getConfig().billing!, products: { [product.id]: 'smoke_pro' } },
    } as never)

    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)

    const customer = await stripe.customers.create({
      test_clock: clock.id,
      email: `clock+${runId}@example.test`,
      metadata: { ...SOURCE_META, run_id: runId, tenantId: tenant.id },
    })
    // Attaching the shared `pm_card_visa` token clones it into a real, customer-
    // scoped PaymentMethod (pm_…). Reuse that concrete id for the default and on
    // the subscription — passing the shared token string again makes Stripe
    // resolve a *fresh* unattached clone ("customer does not have payment method
    // pm_…"), which is exactly what broke this smoke when Stripe stopped
    // deduplicating the token per customer.
    const paymentMethod = await stripe.paymentMethods.attach('pm_card_visa', {
      customer: customer.id,
    })
    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: paymentMethod.id },
    })

    // Local mirror — syncSubscription resolves the tenant by providerCustomerId.
    const mirror = new BillingCustomer()
    mirror.tenantId = tenant.id
    mirror.provider = 'stripe'
    mirror.providerCustomerId = customer.id
    await mirror.save()

    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
      default_payment_method: paymentMethod.id,
      metadata: { ...SOURCE_META, run_id: runId },
    })

    return {
      clockId: clock.id,
      productId: product.id,
      priceId: price.id,
      tenantId: tenant.id,
      customerId: customer.id,
      subscriptionId: subscription.id,
    }
  }

  test('renewal across a cycle: advance the clock → renewal invoice + period advances', async ({
    assert,
    client,
  }) => {
    const webhookSecret = 'whsec_smoke_test_clock_renewal'
    configure(webhookSecret)
    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()
    await billing.verify()
    const stripe = (await billing.getClient()) as Stripe

    const runId = randomUUID().slice(0, 8)
    let ctx: Awaited<ReturnType<typeof provisionOnClock>> | null = null
    try {
      ctx = await provisionOnClock(stripe, runId)
      const sinceCreate = Math.floor(Date.now() / 1000) - 120

      // Initial subscription.created → mirror active on smoke_pro.
      const created = await pullEvent(
        stripe,
        sinceCreate,
        (e) =>
          e.type === 'customer.subscription.created' &&
          (e.data.object as Stripe.Subscription).id === ctx!.subscriptionId
      )
      if (!created) {
        softSkip('customer.subscription.created never surfaced')
        return
      }
      await replay(client, created!, webhookSecret)

      let mirror = await BillingSubscription.find(ctx.subscriptionId)
      assert.isNotNull(mirror, 'subscription mirror created')
      assert.equal(mirror?.planName, 'smoke_pro', 'product mapped to plan')
      assert.include(['active', 'trialing'], mirror?.status ?? '')
      assert.equal((await TenantPlan.find(ctx.tenantId))?.planName, 'smoke_pro')
      const firstPeriodEnd = mirror!.currentPeriodEnd.toMillis()

      // Advance ~32 days so the subscription renews.
      const advanceFrom = Math.floor(Date.now() / 1000) - 5
      await stripe.testHelpers.testClocks.advance(ctx.clockId, {
        frozen_time: Math.floor(Date.now() / 1000) + 32 * 86_400,
      })
      await waitForClockReady(stripe, ctx.clockId)

      // The renewal carries a fresh billing period on subscription.updated.
      const updated = await pullEvent(
        stripe,
        advanceFrom,
        (e) =>
          e.type === 'customer.subscription.updated' &&
          (e.data.object as Stripe.Subscription).id === ctx!.subscriptionId,
        30_000
      )
      if (!updated) {
        softSkip('customer.subscription.updated never surfaced after the clock advance')
        return
      }
      await replay(client, updated!, webhookSecret)

      // Replay the paid renewal invoice too if present (best-effort).
      const paid = await pullEvent(
        stripe,
        advanceFrom,
        (e) =>
          e.type === 'invoice.payment_succeeded' &&
          (e.data.object as Stripe.Invoice).customer === ctx!.customerId,
        15_000
      )
      if (paid) await replay(client, paid, webhookSecret)

      mirror = await BillingSubscription.find(ctx.subscriptionId)
      assert.equal(mirror?.status, 'active', 'still active after the renewal')
      assert.equal(mirror?.planName, 'smoke_pro', 'plan retained across the cycle')
      assert.isAbove(
        mirror!.currentPeriodEnd.toMillis(),
        firstPeriodEnd,
        'billing period advanced after the clock moved a month'
      )
      assert.equal((await TenantPlan.find(ctx.tenantId))?.planName, 'smoke_pro')
    } catch (err) {
      if (isInfraError(err)) {
        softSkip('test clock / Stripe infra failure during the renewal cycle', err)
        return
      }
      throw err
    } finally {
      if (ctx?.clockId) await stripe.testHelpers.testClocks.del(ctx.clockId).catch(() => {})
      if (ctx?.priceId) await stripe.prices.update(ctx.priceId, { active: false }).catch(() => {})
      if (ctx?.productId) {
        await stripe.products.update(ctx.productId, { active: false }).catch(() => {})
      }
    }
  })
    .timeout(90_000)
    .skip(!SHOULD_RUN, 'STRIPE_TEST_API_KEY not set or not sk_test_* — Test Clocks smoke skipped')

  test('failure-path extension: a failed renewal drives the dunning pipeline', async ({
    assert,
    client,
  }) => {
    const webhookSecret = 'whsec_smoke_test_clock_dunning'
    configure(webhookSecret)
    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()
    await billing.verify()
    const stripe = (await billing.getClient()) as Stripe

    const runId = randomUUID().slice(0, 8)
    let ctx: Awaited<ReturnType<typeof provisionOnClock>> | null = null
    const paymentFailedFor: string[] = []
    const off = emitter.on(PaymentFailed, async (e) => {
      paymentFailedFor.push(e.payload.tenantId)
    })
    try {
      ctx = await provisionOnClock(stripe, runId)
      const sinceCreate = Math.floor(Date.now() / 1000) - 120

      const created = await pullEvent(
        stripe,
        sinceCreate,
        (e) =>
          e.type === 'customer.subscription.created' &&
          (e.data.object as Stripe.Subscription).id === ctx!.subscriptionId
      )
      if (!created) {
        softSkip('customer.subscription.created never surfaced')
        return
      }
      await replay(client, created!, webhookSecret)

      // Swap the subscription onto a card that fails when charged, so the next
      // renewal invoice fails instead of paying. Reuse the concrete attached id,
      // not the shared token string (Stripe only resolves the token in `attach`;
      // passing it as `default_payment_method` errors "No such PaymentMethod").
      const failingPm = await stripe.paymentMethods.attach('pm_card_chargeCustomerFail', {
        customer: ctx.customerId,
      })
      await stripe.subscriptions.update(ctx.subscriptionId, {
        default_payment_method: failingPm.id,
      })

      const advanceFrom = Math.floor(Date.now() / 1000) - 5
      await stripe.testHelpers.testClocks.advance(ctx.clockId, {
        frozen_time: Math.floor(Date.now() / 1000) + 32 * 86_400,
      })
      await waitForClockReady(stripe, ctx.clockId)

      const failed = await pullEvent(
        stripe,
        advanceFrom,
        (e) =>
          e.type === 'invoice.payment_failed' &&
          (e.data.object as Stripe.Invoice).customer === ctx!.customerId,
        30_000
      )
      if (!failed) {
        softSkip('invoice.payment_failed never surfaced after the failed renewal')
        return
      }
      await replay(client, failed!, webhookSecret)

      // The failed renewal flowed through the full pipeline: ledger completed
      // and our dunning state machine emitted PaymentFailed for this tenant.
      const ledger = await BillingProcessedEvent.find(failed!.id)
      assert.equal(ledger?.status, 'completed', 'webhook ledger row marked completed')
      assert.include(paymentFailedFor, ctx.tenantId, 'PaymentFailed emitted for the tenant')
    } catch (err) {
      if (isInfraError(err)) {
        softSkip('test clock / Stripe infra failure during the dunning cycle', err)
        return
      }
      throw err
    } finally {
      off()
      if (ctx?.clockId) await stripe.testHelpers.testClocks.del(ctx.clockId).catch(() => {})
      if (ctx?.priceId) await stripe.prices.update(ctx.priceId, { active: false }).catch(() => {})
      if (ctx?.productId) {
        await stripe.products.update(ctx.productId, { active: false }).catch(() => {})
      }
    }
  })
    .timeout(90_000)
    .skip(!SHOULD_RUN, 'STRIPE_TEST_API_KEY not set or not sk_test_* — Test Clocks smoke skipped')
})
