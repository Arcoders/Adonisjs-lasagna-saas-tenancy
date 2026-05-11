import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { BillingService } from '@adonisjs-lasagna/saas-tenancy/services'
import { signWebhookPayload } from '@adonisjs-lasagna/saas-tenancy/testing'
import {
  StripeCustomer,
  StripeProcessedEvent,
  StripeSubscription,
  TenantPlan,
} from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { ProcessStripeEventJob } from '@adonisjs-lasagna/saas-tenancy/jobs'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { testConfig } from '../../helpers/config.js'
import { clearBillingTables, hydrateJob } from './helpers.js'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'
import type Stripe from 'stripe'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Smoke test against the real Stripe test API. SKIPPED unless
 * `STRIPE_TEST_API_KEY` is set to an `sk_test_*` key.
 *
 * To run:
 *   STRIPE_TEST_API_KEY="sk_test_..." npm run test:integration -- \
 *     --files tests/integration/billing/stripe_real_smoke.spec.ts
 *
 * What this test gives us that MockStripe-based tests don't:
 *   - Actual Stripe API surface compatibility (apiVersion, request shape)
 *   - Real `customer.subscription.created` payload (catches drift like
 *     the v18 move of `subscription` under
 *     `parent.subscription_details.subscription`)
 *   - Real signature verification path through the production SDK,
 *     end to end (sign body → SDK constructEvent → controller →
 *     dispatcher → real events.retrieve)
 *   - Confidence that idempotency keys, error mapping, and timeouts
 *     work against a live endpoint, not just the in-memory double
 *
 * What it DOES NOT give us:
 *   - Verification of Stripe's outbound webhook delivery + signature
 *     (Stripe → us). That requires a public endpoint (ngrok / staging)
 *     and is intentionally out of scope here. We replay the real event
 *     by re-fetching it via `events.list` and signing it with our own
 *     test webhook secret — the SDK is verifying our HMAC, not Stripe's.
 *
 * Cleanup is best-effort. Repeated runs leave inert artifacts in the
 * Stripe test account (products archived, customers deleted, but
 * historical subscriptions remain visible). Use Stripe Dashboard's
 * "Clear test data" button periodically.
 */

const REAL_KEY = process.env.STRIPE_TEST_API_KEY
const SHOULD_RUN = typeof REAL_KEY === 'string' && REAL_KEY.startsWith('sk_test_')

test.group('Stripe real-API smoke (T-12)', (group) => {
  const cleanupTenants: string[] = []
  let originalConfig: ReturnType<typeof getConfig>
  let originalDispatch: typeof ProcessStripeEventJob.dispatch
  let pendingJobs: string[] = []

  group.each.setup(async () => {
    originalConfig = getConfig()
    pendingJobs = []
    originalDispatch = ProcessStripeEventJob.dispatch
    ;(ProcessStripeEventJob as unknown as {
      dispatch: (payload: { eventId: string }) => Promise<void>
    }).dispatch = async (p) => {
      pendingJobs.push(p.eventId)
    }
    await clearBillingTables()
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

  test('end-to-end: real customer + subscription → webhook replay → local sync', async ({
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
    billing.__resetForTests()

    // verify() boots the real SDK (peer-dep import, mode check, plan map check).
    await billing.verify()
    const stripe = await billing.getClient()

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

    let stripeCustomerId: string | null = null
    let stripeSubscriptionId: string | null = null

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
      stripeCustomerId = customer.stripeCustomerId
      assert.match(stripeCustomerId, /^cus_/, 'real Stripe returned a customer id')

      // --- 4. Create a subscription (default_incomplete avoids needing a payment method) ---
      const sub = await stripe.subscriptions.create({
        customer: stripeCustomerId,
        items: [{ price: price.id }],
        payment_behavior: 'default_incomplete',
        metadata: { source: 'lasagna-saas-tenancy-smoke-test', run_id: runId },
      })
      stripeSubscriptionId = sub.id
      assert.match(stripeSubscriptionId, /^sub_/, 'real Stripe returned a subscription id')

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
            return obj?.id === stripeSubscriptionId
          }) ?? null
        if (!event) await new Promise((r) => setTimeout(r, 500))
      }
      assert.isNotNull(event, 'customer.subscription.created event must surface within 15s')

      // --- 6. Replay it through our webhook with our own signature ---
      // (Real Stripe SDK verifies; signature secret is the one we
      // configured on the package — not Stripe's actual delivery secret.)
      const body = JSON.stringify(event)
      const sig = signWebhookPayload(body, webhookSecret)

      const res = await client
        .post('/webhooks/stripe')
        .header('content-type', 'application/json')
        .header('stripe-signature', sig)
        .json(event as never)
      res.assertStatus(200)

      // Ledger row inserted, dispatch enqueued. Drain the queue inline.
      assert.lengthOf(pendingJobs, 1, 'one job dispatched for the replayed event')
      while (pendingJobs.length) {
        const eventId = pendingJobs.shift()!
        const job = new ProcessStripeEventJob()
        hydrateJob(job, { eventId })
        await job.execute()
      }

      // --- 7. Assert: local mirror reflects the real Stripe state ---
      const ledger = await StripeProcessedEvent.find(event!.id)
      assert.equal(ledger?.status, 'completed', 'webhook ledger row marked completed')

      const mirror = await StripeSubscription.find(stripeSubscriptionId)
      assert.isNotNull(mirror, 'StripeSubscription mirror created')
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
    } finally {
      // --- 8. Cleanup (best-effort) ---
      if (stripeSubscriptionId) {
        await stripe.subscriptions.cancel(stripeSubscriptionId).catch(() => {})
      }
      if (stripeCustomerId) {
        // Deleting the customer in Stripe also cancels any remaining
        // subscriptions and invalidates payment methods.
        const localCus = await StripeCustomer.query()
          .where('stripeCustomerId', stripeCustomerId)
          .first()
        if (localCus) {
          await stripe.customers.del(stripeCustomerId).catch(() => {})
        }
      }
      // Stripe forbids deleting prices / products that have been used,
      // but archiving keeps the test account tidy.
      await stripe.prices.update(price.id, { active: false }).catch(() => {})
      await stripe.products.update(product.id, { active: false }).catch(() => {})
    }
  })
    .timeout(30_000)
    .skip(
      !SHOULD_RUN,
      'STRIPE_TEST_API_KEY env var not set or not an sk_test_* key — smoke test skipped'
    )
})
