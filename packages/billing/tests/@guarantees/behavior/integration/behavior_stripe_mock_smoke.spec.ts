import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import Stripe from 'stripe'
import { BillingService, BillingException, getActiveBillingDriver } from '@adonisjs-lasagna/billing'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig } from '../../../helpers/helpers.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Layer 2: call-site contract. A REAL Stripe SDK pointed at the official
 * stripe-mock server (no credentials, no network to Stripe) is injected into
 * the active StripeDriver through the existing test seam, then the driver's
 * own SDK call-sites are exercised.
 *
 * stripe-mock is STATELESS and returns canned, schema-valid fixtures, so this
 * asserts call-site SHAPE (the endpoint + params are valid against the current
 * Stripe API schema, and the responses parse), not business behaviour. It
 * catches the drift the hand-written MockStripe can't (a renamed method, a
 * removed/renamed param) without needing test-mode credentials.
 *
 * Skipped unless STRIPE_MOCK_HOST/STRIPE_MOCK_PORT are set. In CI the stripe-mock
 * service container provides them; locally run `docker run -p 12111:12111
 * stripe/stripe-mock` and export the two vars.
 */
const MOCK_HOST = process.env.STRIPE_MOCK_HOST
const MOCK_PORT = process.env.STRIPE_MOCK_PORT
const SHOULD_RUN =
  typeof MOCK_HOST === 'string' &&
  MOCK_HOST.length > 0 &&
  typeof MOCK_PORT === 'string' &&
  MOCK_PORT.length > 0

test.group('Stripe driver call-site contract (stripe-mock)', (group) => {
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(() => {
    originalConfig = getConfig()
    // driver: 'stripe' (already the active driver at boot); fake keys are never
    // used because we inject an SDK below.
    setupBillingConfig({ defaultPlan: 'starter' })
  })

  group.each.teardown(async () => {
    setConfig(originalConfig)
    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()
  })

  test('StripeDriver SDK call-sites are accepted by the current Stripe API schema', async ({
    assert,
  }) => {
    const stripe = new Stripe('sk_test_123', {
      host: MOCK_HOST!,
      port: Number(MOCK_PORT),
      protocol: 'http',
      // Fail fast on an unexpected non-2xx rather than burning the retry budget.
      maxNetworkRetries: 0,
      timeout: 5_000,
    })

    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(stripe)

    const driver = await getActiveBillingDriver()
    assert.equal(driver.name, 'stripe', 'stripe is the active driver')

    const fakeTenant = {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'stripe-mock smoke',
      email: 'stripe-mock@example.test',
    } as unknown as TenantModelContract

    // customers.create
    const customer = await driver.ensureCustomer(fakeTenant)
    assert.match(customer.providerCustomerId, /^cus_/, 'stripe-mock returned a customer id')

    // prices.retrieve (backs BillingService.#assertPriceAllowed)
    const price = await driver.resolvePriceProduct!('price_123')
    assert.isString(price?.id, 'prices.retrieve returned a price')

    // billingPortal.sessions.create
    const portal = await driver.createBillingPortalSession!('cus_123', {
      returnUrl: 'https://example.test/back',
    })
    assert.isString(portal.url, 'billingPortal.sessions.create returned a url')

    // billing.meterEvents.create (resolves void, so the call-site was accepted)
    await driver.reportUsage!('cus_123', { eventName: 'api_request' }, 1, {
      idempotencyKey: 'stripe-mock-smoke-1',
      timestampSeconds: Math.floor(Date.now() / 1000),
    })

    // events.retrieve maps to a neutral event (the tamper-guard re-fetch path)
    const event = await driver.retrieveEvent!('evt_123')
    assert.isNotNull(event, 'events.retrieve mapped to a neutral event')

    // balance.retrieve (billing:doctor / health check)
    await driver.healthCheck!()

    // checkout.sessions.create: the Checkout Session `url` is nullable in the
    // schema, so stripe-mock's fixture may omit it and the driver raises its own
    // `api_error` guard. Either outcome proves the call-site is valid; only an
    // unexpected (non-BillingException) error should fail the test.
    try {
      const checkout = await driver.createCheckoutSession(fakeTenant, 'cus_123', {
        priceId: 'price_123',
        successUrl: 'https://example.test/ok',
        cancelUrl: 'https://example.test/cancel',
      })
      assert.match(checkout.url, /^https?:\/\//)
      assert.isString(checkout.id)
    } catch (err) {
      assert.instanceOf(
        err,
        BillingException,
        'checkout.sessions.create must only reject via our own guard, never an SDK/network error'
      )
    }
  })
    .timeout(30_000)
    .skip(
      !SHOULD_RUN,
      'STRIPE_MOCK_HOST/STRIPE_MOCK_PORT not set — stripe-mock call-site test skipped'
    )
})
