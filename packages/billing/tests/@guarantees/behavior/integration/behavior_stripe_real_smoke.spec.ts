import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { BillingService } from '@adonisjs-lasagna/billing'
import { signWebhookPayload } from '@adonisjs-lasagna/billing'
import { getActiveBillingDriver } from '@adonisjs-lasagna/billing'
import { TenantPlan } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import {
  BillingCustomer,
  BillingUsageEvent,
  BillingProcessedEvent,
  BillingSubscription,
} from '@adonisjs-lasagna/billing'
import type { Subscription, SubscriptionStatus } from '@adonisjs-lasagna/billing'
import { ProcessBillingEventJob } from '@adonisjs-lasagna/billing'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { testConfig } from '@adonisjs-lasagna/satellite-test-kit/testing'
import {
  clearBillingTables,
  hydrateJob,
  assertNeutralSubscription,
} from '../../../helpers/helpers.js'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'
import type Stripe from 'stripe'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

// Smoke test against the real Stripe test API. Skipped unless
// STRIPE_TEST_API_KEY is set (sk_test_*). Catches drift in Stripe's
// payload/API surface that MockStripe can't surface (e.g. the v18 move
// of `subscription` under `parent.subscription_details.subscription`).
//
// Cleanup is best-effort; periodic "Clear test data" in the Stripe
// Dashboard handles leftover historical subscriptions.

const REAL_KEY = process.env.STRIPE_TEST_API_KEY
const SHOULD_RUN = typeof REAL_KEY === 'string' && REAL_KEY.startsWith('sk_test_')

test.group('Stripe real-API smoke (T-12)', (group) => {
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

  test('SDK call-site contract: checkout + portal + metered usage + subscriptions.list + balance.retrieve', async ({
    assert,
  }) => {
    // Exercises the *other* Stripe SDK surfaces the package calls into,
    // the ones the subscription-lifecycle test above doesn't touch:
    //   - stripe.checkout.sessions.create   (BillingService.createCheckoutSession)
    //   - stripe.prices.retrieve            (BillingService.#assertPriceAllowed)
    //   - stripe.billingPortal.sessions.create (BillingService.createBillingPortalSession)
    //   - stripe.billing.meters.create / .deactivate (test fixture; required so meterEvents.create has a target)
    //   - stripe.billing.meterEvents.create (BillingService.reportUsage, with idempotency key)
    //   - stripe.subscriptions.list         (billing:sync command)
    //   - stripe.balance.retrieve           (billing:doctor / billing_health_check)
    // If Stripe renames or reshapes any of these, this test fails in CI
    // instead of in a customer's production logs.
    const runId = randomUUID().slice(0, 8)
    const webhookSecret = 'whsec_smoke_test_real_stripe_callsites'

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
        products: {},
        defaultPlan: 'starter',
      },
    } as never)

    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()
    await billing.verify()
    const stripe = (await billing.getClient()) as Stripe

    // --- Fixtures: product + price + a Billing Meter (so meterEvents has a target) ---
    const product = await stripe.products.create({
      name: `Lasagna smoke callsites ${runId}`,
      metadata: { source: 'lasagna-saas-tenancy-smoke-test', run_id: runId },
    })
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: 1500,
      currency: 'usd',
      recurring: { interval: 'month' },
      metadata: { source: 'lasagna-saas-tenancy-smoke-test', run_id: runId },
    })
    const meterEventName = `lasagna_smoke_usage_${runId}`
    const meter = await stripe.billing.meters.create({
      display_name: `Lasagna smoke meter ${runId}`,
      event_name: meterEventName,
      default_aggregation: { formula: 'sum' },
      value_settings: { event_payload_key: 'value' },
      customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' },
    })

    // Ensure a Customer Portal configuration exists. In a fresh test
    // account no default exists and `billingPortal.sessions.create` 500s.
    // Creating one when none exists makes it the account default.
    await stripe.billingPortal.configurations
      .create({
        business_profile: { headline: 'Lasagna SaaS Tenancy — smoke test' },
        features: { invoice_history: { enabled: true } },
      })
      .catch(() => {
        /* a default already exists, fine */
      })

    setConfig({
      ...getConfig(),
      billing: { ...getConfig().billing!, products: { [product.id]: 'smoke_pro' } },
    } as never)

    let providerCustomerId: string | null = null
    let subId: string | null = null
    try {
      const tenant = await createTestTenant()
      cleanupTenants.push(tenant.id)
      const fakeTenant = {
        id: tenant.id,
        name: tenant.name ?? `smoke ${runId}`,
        email: tenant.email ?? `smoke+${runId}@example.test`,
      } as unknown as TenantModelContract

      // --- checkout.sessions.create (+ ensureCustomer/customers.create + prices.retrieve) ---
      const checkout = await billing.createCheckoutSession(fakeTenant, {
        priceId: price.id,
        successUrl: 'https://example.test/billing/ok',
        cancelUrl: 'https://example.test/billing/cancel',
      })
      assert.match(checkout.id, /^cs_/, 'real Stripe returned a checkout session id')
      assert.match(checkout.url, /^https:\/\//, 'real Stripe returned a checkout URL')

      const localCus = await BillingCustomer.find(tenant.id)
      assert.isNotNull(localCus, 'ensureCustomer persisted a BillingCustomer mirror row')
      providerCustomerId = localCus!.providerCustomerId
      assert.match(providerCustomerId, /^cus_/)

      // --- billingPortal.sessions.create ---
      const portal = await billing.createBillingPortalSession(fakeTenant, {
        returnUrl: 'https://example.test/billing/back',
      })
      assert.match(portal.url, /^https:\/\//, 'real Stripe returned a billing portal URL')

      // --- billing.meterEvents.create via reportUsage (with idempotency key) ---
      const usageKey = `smoke:${tenant.id}:${meterEventName}:fixed`
      await billing.reportUsage(fakeTenant, { eventName: meterEventName }, 7, {
        idempotencyKey: usageKey,
      })
      let usageRows = await BillingUsageEvent.query().where('idempotencyKey', usageKey)
      assert.lengthOf(usageRows, 1, 'one BillingUsageEvent audit row written')
      assert.equal(usageRows[0]?.status, 'sent', 'meter event reported to Stripe')
      assert.equal(Number(usageRows[0]?.quantity), 7)
      assert.isNotNull(usageRows[0]?.reportedAt)

      // Re-report with the SAME idempotency key. The DB-level dedupe
      // short-circuits before re-hitting Stripe; still exactly one row,
      // still 'sent'. (Stripe's own idempotency cache covered the first
      // call's `{ idempotencyKey }` param.)
      await billing.reportUsage(fakeTenant, { eventName: meterEventName }, 7, {
        idempotencyKey: usageKey,
      })
      usageRows = await BillingUsageEvent.query().where('idempotencyKey', usageKey)
      assert.lengthOf(usageRows, 1, 'duplicate reportUsage did not create a second audit row')

      // --- subscriptions.list (the shape billing:sync relies on) ---
      const sub = await stripe.subscriptions.create({
        customer: providerCustomerId,
        items: [{ price: price.id }],
        payment_behavior: 'default_incomplete',
        metadata: { source: 'lasagna-saas-tenancy-smoke-test', run_id: runId },
      })
      subId = sub.id
      const listed = await stripe.subscriptions.list({ status: 'all', limit: 100 })
      assert.equal(listed.object, 'list')
      assert.isArray(listed.data)
      assert.isBoolean(listed.has_more)
      assert.isTrue(
        listed.data.some((s) => s.id === subId),
        'the subscription we just created shows up in subscriptions.list'
      )

      // --- balance.retrieve (billing:doctor / billing_health_check) ---
      const balance = await stripe.balance.retrieve()
      assert.equal(balance.object, 'balance')
      assert.isArray(balance.available)
    } finally {
      if (subId) await stripe.subscriptions.cancel(subId).catch(() => {})
      if (providerCustomerId) await stripe.customers.del(providerCustomerId).catch(() => {})
      await stripe.billing.meters.deactivate(meter.id).catch(() => {})
      await stripe.prices.update(price.id, { active: false }).catch(() => {})
      await stripe.products.update(product.id, { active: false }).catch(() => {})
    }
  })
    .timeout(45_000)
    .skip(
      !SHOULD_RUN,
      'STRIPE_TEST_API_KEY env var not set or not an sk_test_* key — smoke test skipped'
    )

  test('end-to-end: real customer + subscription → sync → cancel → sync → downgrade', async ({
    assert,
    client,
  }) => {
    const webhookSecret = 'whsec_smoke_test_real_stripe_replay'

    // --- 1. Configure billing with the real test key + a known webhook secret ---
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
        stripe: {
          apiKey: REAL_KEY!,
          webhookSecret,
        },
        // Populated below once the test product is created.
        products: {},
        defaultPlan: 'starter',
      },
    } as never)

    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()

    // verify() boots the real SDK (peer-dep import, mode check, plan map check).
    await billing.verify()
    const stripe = (await billing.getClient()) as Stripe

    // --- 2. Provision a unique product + price for this run ---
    const runId = randomUUID().slice(0, 8)
    const product = await stripe.products.create({
      name: `Lasagna smoke ${runId}`,
      metadata: { source: 'lasagna-saas-tenancy-smoke-test', run_id: runId },
    })
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: 1000,
      currency: 'usd',
      recurring: { interval: 'month' },
      metadata: { source: 'lasagna-saas-tenancy-smoke-test', run_id: runId },
    })

    // Now wire the freshly-created product into the allowlist so
    // syncSubscription resolves it to `smoke_pro`.
    const cfgAfterProduct = getConfig()
    setConfig({
      ...cfgAfterProduct,
      billing: {
        ...cfgAfterProduct.billing!,
        products: { [product.id]: 'smoke_pro' },
      },
    } as never)

    let providerCustomerId: string | null = null
    let providerSubscriptionId: string | null = null

    try {
      // --- 3. Create tenant + Stripe customer ---
      const tenant = await createTestTenant()
      cleanupTenants.push(tenant.id)
      const fakeTenant = {
        id: tenant.id,
        name: tenant.name ?? `smoke ${runId}`,
        email: tenant.email ?? `smoke+${runId}@example.test`,
      } as unknown as TenantModelContract

      const customer = await billing.ensureCustomer(fakeTenant)
      providerCustomerId = customer.providerCustomerId
      assert.match(providerCustomerId, /^cus_/, 'real Stripe returned a customer id')

      // --- 4. Create a subscription (default_incomplete avoids needing a payment method) ---
      const sub = await stripe.subscriptions.create({
        customer: providerCustomerId,
        items: [{ price: price.id }],
        payment_behavior: 'default_incomplete',
        metadata: { source: 'lasagna-saas-tenancy-smoke-test', run_id: runId },
      })
      providerSubscriptionId = sub.id
      assert.match(providerSubscriptionId, /^sub_/, 'real Stripe returned a subscription id')

      // --- 5. Pull the corresponding subscription.created event from Stripe ---
      // Stripe events propagate near-synchronously but allow a short
      // poll window in case of brief eventual consistency.
      let event: Stripe.Event | null = null
      const fromTs = Math.floor(Date.now() / 1000) - 60
      const deadline = Date.now() + 15_000
      while (!event && Date.now() < deadline) {
        const list = await stripe.events.list({
          type: 'customer.subscription.created',
          limit: 30,
          created: { gte: fromTs },
        })
        event =
          list.data.find((e) => {
            const obj = e.data.object as Stripe.Subscription
            return obj?.id === providerSubscriptionId
          }) ?? null
        if (!event) await new Promise((r) => setTimeout(r, 500))
      }
      assert.isNotNull(event, 'customer.subscription.created event must surface within 15s')

      // --- 6. Replay it through our webhook with our own signature ---
      // (Real Stripe SDK verifies; signature secret is the one we
      // configured on the package, not Stripe's actual delivery secret.)
      const body = JSON.stringify(event)
      const sig = signWebhookPayload(body, webhookSecret)

      const res = await client
        .post('/webhooks/billing')
        .header('content-type', 'application/json')
        .header('stripe-signature', sig)
        .json(event as never)
      res.assertStatus(200)

      // Ledger row inserted, dispatch enqueued. Drain the queue inline.
      assert.lengthOf(pendingJobs, 1, 'one job dispatched for the replayed event')
      while (pendingJobs.length) {
        const eventId = pendingJobs.shift()!
        const job = new ProcessBillingEventJob()
        hydrateJob(job, { eventId })
        await job.execute()
      }

      // --- 7. Assert: local mirror reflects the real Stripe state ---
      const ledger = await BillingProcessedEvent.find(event!.id)
      assert.equal(ledger?.status, 'completed', 'webhook ledger row marked completed')

      const mirror = await BillingSubscription.find(providerSubscriptionId)
      assert.isNotNull(mirror, 'BillingSubscription mirror created')
      assert.equal(mirror?.tenantId, tenant.id)
      assert.equal(mirror?.planName, 'smoke_pro', 'product mapping resolved to local plan')
      const expectedStatuses = ['active', 'incomplete', 'trialing']
      assert.isTrue(
        expectedStatuses.includes(mirror?.status ?? ''),
        `real-Stripe subscription status (${mirror?.status}) must be one of ${expectedStatuses.join(', ')}`
      )

      const tp = await TenantPlan.find(tenant.id)
      assert.equal(tp?.planName, 'smoke_pro', 'tenant_plans assigned via QuotaService')
      assert.equal(tp?.source, 'stripe')

      // --- 8. Cancel in Stripe, feed the REAL canceled subscription
      // through syncSubscription, and verify the downgrade. We pass the object
      // `subscriptions.cancel()` returns rather than polling `events.list`
      // for the `customer.subscription.deleted` event. The latter's
      // propagation timing is variable enough to flake a smoke test, and
      // the thing we actually care about (Stripe's real cancellation
      // payload shape: `canceled_at`, `cancellation_details`, the v18
      // nesting, status='canceled') is fully present on the returned
      // object. The webhook/controller/job path for deletions is covered
      // exhaustively by the MockStripe-based specs.
      const canceled = await stripe.subscriptions.cancel(providerSubscriptionId)
      // Canceling an `incomplete` sub (we created it `default_incomplete`
      // to avoid needing a payment method) terminates it as
      // `incomplete_expired`; an active one would be `canceled`. Accept
      // either terminal status. The payload shape is what we're after.
      const terminal = ['canceled', 'incomplete_expired']
      assert.isTrue(
        terminal.includes(canceled.status),
        `Stripe reports the subscription terminated (got '${canceled.status}')`
      )
      // syncSubscription consumes a neutral Subscription now; map the real
      // canceled Stripe object onto it (downgrade:true ignores product mapping).
      const item0 = canceled.items?.data?.[0] as
        | { current_period_start?: number; current_period_end?: number }
        | undefined
      const nowSec = Math.floor(Date.now() / 1000)
      const neutralCanceled: Subscription = {
        providerSubscriptionId: canceled.id,
        customerId:
          typeof canceled.customer === 'string' ? canceled.customer : (canceled.customer?.id ?? ''),
        status: canceled.status as SubscriptionStatus,
        currentPeriodStart: item0?.current_period_start ?? nowSec,
        currentPeriodEnd: item0?.current_period_end ?? nowSec,
        cancelAtPeriodEnd: canceled.cancel_at_period_end ?? false,
        cancelAt: canceled.cancel_at ?? null,
        canceledAt: canceled.canceled_at ?? null,
        trialEnd: canceled.trial_end ?? null,
        productId: null,
        priceId: null,
        raw: canceled as unknown as Record<string, unknown>,
      }
      await billing.syncSubscription(neutralCanceled, nowSec, { downgrade: true })

      const canceledMirror = await BillingSubscription.find(providerSubscriptionId)
      assert.equal(
        canceledMirror?.status,
        canceled.status,
        'mirror reflects the real terminal status'
      )
      const tpAfterCancel = await TenantPlan.find(tenant.id)
      assert.equal(tpAfterCancel?.planName, 'starter', 'downgraded to defaultPlan after cancel')
    } finally {
      // --- 8. Cleanup (best-effort) ---
      if (providerSubscriptionId) {
        await stripe.subscriptions.cancel(providerSubscriptionId).catch(() => {})
      }
      if (providerCustomerId) {
        // Deleting the customer in Stripe also cancels any remaining
        // subscriptions and invalidates payment methods.
        const localCus = await BillingCustomer.query()
          .where('providerCustomerId', providerCustomerId)
          .first()
        if (localCus) {
          await stripe.customers.del(providerCustomerId).catch(() => {})
        }
      }
      // Stripe forbids deleting prices / products that have been used,
      // but archiving keeps the test account tidy.
      await stripe.prices.update(price.id, { active: false }).catch(() => {})
      await stripe.products.update(product.id, { active: false }).catch(() => {})
    }
  })
    .timeout(45_000)
    .skip(
      !SHOULD_RUN,
      'STRIPE_TEST_API_KEY env var not set or not an sk_test_* key — smoke test skipped'
    )

  test('reconciliation: driver.listSubscriptions enumerates the live API (auth + pagination + mapping)', async ({
    assert,
  }) => {
    // The "SDK call-site" test above calls `stripe.subscriptions.list` raw; this
    // one exercises the *driver's* `listSubscriptions()` async generator (the
    // code path `tenant:billing:sync` actually uses) against the real API,
    // closing the "generator, not raw SDK" gap. Tolerates zero rows.
    setConfig({
      ...testConfig,
      plans: {
        defaultPlan: 'starter',
        definitions: { starter: { limits: { apiRequests: 100 } } },
        storage: 'tenant_plans',
      },
      billing: {
        driver: 'stripe',
        stripe: { apiKey: REAL_KEY!, webhookSecret: 'whsec_smoke_reconcile' },
        products: {},
        defaultPlan: 'starter',
      },
    } as never)
    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()
    await billing.verify()

    const driver = await getActiveBillingDriver()
    assert.isTrue(driver.supports('subscription_list'), 'stripe advertises subscription_list')
    assert.isFunction(driver.listSubscriptions, 'stripe implements listSubscriptions')

    let count = 0
    for await (const sub of driver.listSubscriptions!()) {
      assertNeutralSubscription(sub)
      if (++count >= 200) break
    }
    assert.isAtLeast(count, 0, 'listSubscriptions drained without throwing')
  })
    .timeout(45_000)
    .skip(
      !SHOULD_RUN,
      'STRIPE_TEST_API_KEY env var not set or not an sk_test_* key — reconciliation smoke skipped'
    )
})
