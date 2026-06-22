import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { createHmac, randomUUID } from 'node:crypto'
import {
  BillingService,
  BillingCustomer,
  BillingDriverRegistry,
  LemonSqueezyDriver,
  getActiveBillingDriver,
} from '@adonisjs-lasagna/billing'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { testConfig } from '@adonisjs-lasagna/satellite-test-kit/testing'
import { clearBillingTables, assertNeutralSubscription } from './helpers.js'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Smoke test against a real Lemon Squeezy **test-mode** store. Skipped unless
 * both LEMONSQUEEZY_TEST_API_KEY and LEMONSQUEEZY_TEST_STORE_ID are set (the
 * driver's `verifyConfig` requires the store id). Catches drift in the LS
 * JSON:API surface and the `X-Signature` webhook scheme that the in-process
 * mock + unit mapper specs can't see.
 *
 * Extra knobs:
 *   - LEMONSQUEEZY_TEST_WEBHOOK_SECRET — signs the round-trip body (any value;
 *     the driver verifies against the same configured secret). Defaults to a
 *     fixed string so the round-trip runs without it.
 *   - LEMONSQUEEZY_TEST_VARIANT_ID — a catalog variant id; enables the live
 *     checkout-session test.
 *
 * Cleanup is best-effort and per-run unique emails avoid collisions.
 */
const API_KEY = process.env.LEMONSQUEEZY_TEST_API_KEY
const STORE_ID = process.env.LEMONSQUEEZY_TEST_STORE_ID
const WEBHOOK_SECRET = process.env.LEMONSQUEEZY_TEST_WEBHOOK_SECRET ?? 'lsq_smoke_secret'
const VARIANT_ID = process.env.LEMONSQUEEZY_TEST_VARIANT_ID
const SHOULD_RUN =
  typeof API_KEY === 'string' &&
  API_KEY.length > 0 &&
  typeof STORE_ID === 'string' &&
  STORE_ID.length > 0
const HAS_VARIANT = SHOULD_RUN && typeof VARIANT_ID === 'string' && VARIANT_ID.length > 0

/** LS `X-Signature` is the hex HMAC-SHA256 of the raw body. */
function signLemonSqueezy(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

test.group('Lemon Squeezy real-API smoke (test mode)', (group) => {
  const cleanupTenants: string[] = []
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(async () => {
    originalConfig = getConfig()
    await clearBillingTables()
    const registry = await app.container.make(BillingDriverRegistry)
    registry.register(new LemonSqueezyDriver(), { activate: true })
  })

  group.each.teardown(async () => {
    await clearBillingTables()
    while (cleanupTenants.length) {
      const id = cleanupTenants.pop()!
      await destroyTestTenant(id).catch(() => {})
    }
    const registry = await app.container.make(BillingDriverRegistry)
    if (registry.has('stripe')) registry.use('stripe')
    setConfig(originalConfig)
    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()
  })

  function configureLemonSqueezy(products: Record<string, string> = {}): void {
    setConfig({
      ...testConfig,
      plans: {
        defaultPlan: 'starter',
        definitions: {
          starter: { limits: { apiRequests: 100 } },
          pro: { limits: { apiRequests: 10_000 } },
        },
        storage: 'tenant_plans',
      },
      billing: {
        driver: 'lemonsqueezy',
        lemonSqueezy: { apiKey: API_KEY!, webhookSecret: WEBHOOK_SECRET, storeId: STORE_ID! },
        products,
        defaultPlan: 'starter',
      },
    } as never)
  }

  test('verify + ensureCustomer (live POST /customers) + X-Signature round-trip', async ({
    assert,
  }) => {
    configureLemonSqueezy()
    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()
    await billing.verify()

    const runId = randomUUID().slice(0, 8)
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const fakeTenant = {
      id: tenant.id,
      name: tenant.name ?? `ls smoke ${runId}`,
      email: `ls-smoke+${runId}@example.test`,
    } as unknown as TenantModelContract

    // --- live customer create (+ local mirror) ---
    const customer = await billing.ensureCustomer(fakeTenant)
    assert.match(customer.providerCustomerId, /^\d+$/, 'LS returned a numeric customer id')
    assert.equal(customer.provider, 'lemonsqueezy', 'mirror records the provider')

    const mirror = await BillingCustomer.find(tenant.id)
    assert.isNotNull(mirror, 'ensureCustomer persisted a billing_customers mirror row')
    assert.equal(mirror?.provider, 'lemonsqueezy')

    // --- webhook signature scheme: sign + parse through the real driver ---
    const driver = await getActiveBillingDriver()
    const body = JSON.stringify({
      meta: { event_name: 'subscription_created' },
      data: {
        id: 42,
        attributes: {
          status: 'active',
          customer_id: Number(customer.providerCustomerId),
          product_id: 3,
          variant_id: 9,
          created_at: '2024-01-01T00:00:00Z',
          renews_at: '2024-02-01T00:00:00Z',
        },
      },
    })
    const event = await driver.parseWebhookEvent(body, signLemonSqueezy(body, WEBHOOK_SECRET))
    assert.equal(event.provider, 'lemonsqueezy')
    assert.equal(event.type, 'subscription.upsert')
    assert.equal((event.data as { providerSubscriptionId: string }).providerSubscriptionId, '42')

    // a wrong signature must be rejected
    await assert.rejects(() => driver.parseWebhookEvent(body, 'deadbeef'))
  })
    .timeout(45_000)
    .skip(
      !SHOULD_RUN,
      'LEMONSQUEEZY_TEST_API_KEY/LEMONSQUEEZY_TEST_STORE_ID not set — Lemon Squeezy smoke test skipped'
    )

  test('reconciliation: listSubscriptions pages the live store (auth + pagination + mapping)', async ({
    assert,
  }) => {
    configureLemonSqueezy()
    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()
    await billing.verify()

    const driver = await getActiveBillingDriver()
    assert.isTrue(driver.supports('subscription_list'), 'LS advertises subscription_list')
    assert.isFunction(driver.listSubscriptions, 'LS implements listSubscriptions')

    // Drain against the REAL test-mode store. Tolerates zero rows: an empty
    // store still proves auth, the filter[store_id] / page[number] params, the
    // JSON:API lastPage loop, and toSubscription mapping against the live
    // surface — what the stubbed lemon_squeezy_driver.spec.ts cannot. Capped so
    // a populated store can't make the smoke run unbounded.
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
      'LEMONSQUEEZY_TEST_API_KEY/LEMONSQUEEZY_TEST_STORE_ID not set — Lemon Squeezy reconciliation smoke skipped'
    )

  test('live checkout session (needs LEMONSQUEEZY_TEST_VARIANT_ID)', async ({ assert }) => {
    // LS can't resolve price→product, so the variant id must be allowlisted
    // directly in config.billing.products (the fast path).
    configureLemonSqueezy({ [VARIANT_ID!]: 'pro' })
    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()
    await billing.verify()

    const driver = await getActiveBillingDriver()
    assert.isFalse(driver.supports('price_lookup'), 'LS does not support price lookup')

    const runId = randomUUID().slice(0, 8)
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const fakeTenant = {
      id: tenant.id,
      name: tenant.name ?? `ls smoke ${runId}`,
      email: `ls-checkout+${runId}@example.test`,
    } as unknown as TenantModelContract

    const checkout = await billing.createCheckoutSession(fakeTenant, {
      priceId: VARIANT_ID!,
      successUrl: 'https://example.test/billing/ok',
      cancelUrl: 'https://example.test/billing/cancel',
    })
    assert.isString(checkout.id)
    assert.match(checkout.url, /^https?:\/\//, 'LS returned a hosted checkout URL')
  })
    .timeout(45_000)
    .skip(
      !HAS_VARIANT,
      'LEMONSQUEEZY_TEST_API_KEY/STORE_ID/VARIANT_ID not set — Lemon Squeezy checkout smoke skipped'
    )
})
