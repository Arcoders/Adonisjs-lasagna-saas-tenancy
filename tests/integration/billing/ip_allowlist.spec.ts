import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { BillingService } from '@adonisjs-lasagna/saas-tenancy/services'
import { MockStripe, signWebhookPayload } from '@adonisjs-lasagna/saas-tenancy/testing'
import { isStripeWebhookOriginAllowed } from '../../../src/services/billing/stripe_ip_allowlist.js'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, buildEvent, buildSubscription, clearBillingTables } from './helpers.js'

/**
 * IP allowlist is opt-in (`enforceIpAllowlist=true`). When off, every IP
 * passes (defence-in-depth, not a primary control). When on, only IPs in
 * `allowedIps` are accepted.
 *
 * The middleware short-circuits BEFORE signature verification, so a
 * blocked IP gets a fast 401 without paying the HMAC cost.
 */
test.group('IP allowlist (integration)', (group) => {
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(async () => {
    originalConfig = getConfig()
    await clearBillingTables()
  })

  group.each.teardown(async () => {
    await clearBillingTables()
    setConfig(originalConfig)
    const billing = await app.container.make(BillingService)
    billing.__resetForTests()
  })

  test('helper allows everything when enforce flag is off (default)', ({ assert }) => {
    setupBillingConfig({ defaultPlan: 'starter' })
    assert.isTrue(isStripeWebhookOriginAllowed('1.2.3.4'))
    assert.isTrue(isStripeWebhookOriginAllowed(undefined))
    assert.isTrue(isStripeWebhookOriginAllowed('::1'))
  })

  test('helper rejects unknown IPs when enforce is on', ({ assert }) => {
    setConfig({
      ...originalConfig,
      plans: {
        defaultPlan: 'starter',
        definitions: { starter: { limits: {} } },
        storage: 'tenant_plans',
      },
      billing: {
        driver: 'stripe',
        stripe: { apiKey: 'sk_test_x', webhookSecret: 'whsec_test_billing_helper' },
        products: { prod_starter: 'starter' },
        defaultPlan: 'starter',
        webhook: {
          enforceIpAllowlist: true,
          allowedIps: ['54.187.174.169', '54.187.205.235'],
        },
      },
    } as never)

    assert.isTrue(isStripeWebhookOriginAllowed('54.187.174.169'))
    assert.isFalse(isStripeWebhookOriginAllowed('1.2.3.4'))
    assert.isFalse(isStripeWebhookOriginAllowed(undefined))
  })

  test('helper normalises IPv4-mapped IPv6 (::ffff:1.2.3.4)', ({ assert }) => {
    setConfig({
      ...originalConfig,
      plans: {
        defaultPlan: 'starter',
        definitions: { starter: { limits: {} } },
        storage: 'tenant_plans',
      },
      billing: {
        driver: 'stripe',
        stripe: { apiKey: 'sk_test_x', webhookSecret: 'whsec_test_billing_helper' },
        products: { prod_starter: 'starter' },
        defaultPlan: 'starter',
        webhook: {
          enforceIpAllowlist: true,
          allowedIps: ['54.187.174.169'],
        },
      },
    } as never)

    // Node sometimes reports IPv4 connections as ::ffff:<v4>. The helper
    // strips the prefix before matching.
    assert.isTrue(isStripeWebhookOriginAllowed('::ffff:54.187.174.169'))
  })

  test('helper rejects malformed IP strings', ({ assert }) => {
    setConfig({
      ...originalConfig,
      plans: {
        defaultPlan: 'starter',
        definitions: { starter: { limits: {} } },
        storage: 'tenant_plans',
      },
      billing: {
        driver: 'stripe',
        stripe: { apiKey: 'sk_test_x', webhookSecret: 'whsec_test_billing_helper' },
        products: { prod_starter: 'starter' },
        defaultPlan: 'starter',
        webhook: {
          enforceIpAllowlist: true,
          allowedIps: ['54.187.174.169'],
        },
      },
    } as never)

    assert.isFalse(isStripeWebhookOriginAllowed('not-an-ip'))
    assert.isFalse(isStripeWebhookOriginAllowed(''))
  })

  test('middleware blocks a request whose IP fails the allowlist', async ({ client }) => {
    setConfig({
      ...originalConfig,
      plans: {
        defaultPlan: 'starter',
        definitions: { starter: { limits: {} } },
        storage: 'tenant_plans',
      },
      billing: {
        driver: 'stripe',
        stripe: { apiKey: 'sk_test_x', webhookSecret: 'whsec_test_billing_helper' },
        products: { prod_starter: 'starter' },
        defaultPlan: 'starter',
        webhook: {
          enforceIpAllowlist: true,
          // Address the test client doesn't use:
          allowedIps: ['203.0.113.1'],
        },
      },
    } as never)

    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const event = buildEvent('customer.subscription.created', buildSubscription())
    const body = JSON.stringify(event)
    const sig = signWebhookPayload(body, 'whsec_test_billing_helper')

    const res = await client
      .post('/webhooks/stripe')
      .header('content-type', 'application/json')
      .header('stripe-signature', sig)
      .json(event)

    res.assertStatus(401)
  })
})
