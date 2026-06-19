import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { createHmac, randomUUID } from 'node:crypto'
import {
  BillingService,
  BillingCustomer,
  BillingDriverRegistry,
  PaddleDriver,
  getActiveBillingDriver,
} from '@adonisjs-lasagna/billing'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { testConfig } from '@adonisjs-lasagna/satellite-test-kit/testing'
import { clearBillingTables } from './helpers.js'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Smoke test against the real Paddle **sandbox** API. Skipped unless
 * PADDLE_TEST_API_KEY is set. Catches drift in Paddle's REST surface and the
 * `Paddle-Signature` webhook scheme that the in-process MockBillingDriver and
 * the unit mapper specs can't see.
 *
 * Two extra knobs widen coverage when present (the basic run only needs the
 * API key):
 *   - PADDLE_TEST_WEBHOOK_SECRET — signs the round-trip body (any value works;
 *     the driver verifies against the same configured secret). Defaults to a
 *     fixed string so the round-trip runs with just the API key.
 *   - PADDLE_TEST_PRICE_ID — a catalog price id; enables the live
 *     price-lookup + checkout-session test.
 *
 * Cleanup is best-effort: Paddle sandbox customers/transactions can't be hard
 * deleted via the API, so we use a unique email per run and leave the rest for
 * periodic sandbox resets.
 */
const API_KEY = process.env.PADDLE_TEST_API_KEY
const WEBHOOK_SECRET = process.env.PADDLE_TEST_WEBHOOK_SECRET ?? 'pdl_ntfset_smoke_secret'
const PRICE_ID = process.env.PADDLE_TEST_PRICE_ID
const SHOULD_RUN = typeof API_KEY === 'string' && API_KEY.length > 0
const HAS_PRICE = SHOULD_RUN && typeof PRICE_ID === 'string' && PRICE_ID.length > 0

/** Build the `Paddle-Signature` header for a body: `ts=<unix>;h1=<hmac(ts:body)>`. */
function signPaddle(body: string, secret: string): string {
  const ts = Math.floor(Date.now() / 1000).toString()
  const h1 = createHmac('sha256', secret).update(`${ts}:${body}`, 'utf8').digest('hex')
  return `ts=${ts};h1=${h1}`
}

test.group('Paddle real-API smoke (sandbox)', (group) => {
  const cleanupTenants: string[] = []
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(async () => {
    originalConfig = getConfig()
    await clearBillingTables()
    // Make Paddle the active driver for this group. Restored in teardown so the
    // Stripe-driver specs sharing this process aren't affected.
    const registry = await app.container.make(BillingDriverRegistry)
    registry.register(new PaddleDriver(), { activate: true })
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

  function configurePaddle(products: Record<string, string> = {}): void {
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
        driver: 'paddle',
        paddle: { apiKey: API_KEY!, webhookSecret: WEBHOOK_SECRET, environment: 'sandbox' },
        products,
        defaultPlan: 'starter',
      },
    } as never)
  }

  test('verify + ensureCustomer (live POST /customers) + Paddle-Signature round-trip', async ({
    assert,
  }) => {
    configurePaddle()
    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()
    await billing.verify()

    const runId = randomUUID().slice(0, 8)
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const fakeTenant = {
      id: tenant.id,
      name: tenant.name ?? `paddle smoke ${runId}`,
      email: `paddle-smoke+${runId}@example.test`,
    } as unknown as TenantModelContract

    // --- live customer create (+ local mirror) ---
    const customer = await billing.ensureCustomer(fakeTenant)
    assert.match(customer.providerCustomerId, /^ctm_/, 'Paddle returned a customer id (ctm_…)')
    assert.equal(customer.provider, 'paddle', 'mirror records the provider')

    const mirror = await BillingCustomer.find(tenant.id)
    assert.isNotNull(mirror, 'ensureCustomer persisted a billing_customers mirror row')
    assert.equal(mirror?.provider, 'paddle')

    // --- webhook signature scheme: sign a body and parse it back through the
    // real driver (validates the Paddle-Signature ts:body HMAC + the mapper) ---
    const driver = await getActiveBillingDriver()
    const body = JSON.stringify({
      event_id: `ntf_${runId}`,
      event_type: 'subscription.created',
      occurred_at: new Date().toISOString(),
      data: {
        id: `sub_${runId}`,
        customer_id: customer.providerCustomerId,
        status: 'active',
        current_billing_period: {
          starts_at: '2024-01-01T00:00:00Z',
          ends_at: '2024-02-01T00:00:00Z',
        },
        items: [{ price: { id: 'pri_smoke', product_id: 'pro_smoke' } }],
      },
    })
    const event = await driver.parseWebhookEvent(body, signPaddle(body, WEBHOOK_SECRET))
    assert.equal(event.provider, 'paddle')
    assert.equal(event.type, 'subscription.upsert')
    assert.equal(
      (event.data as { providerSubscriptionId: string }).providerSubscriptionId,
      `sub_${runId}`
    )

    // a tampered/absent signature must be rejected
    await assert.rejects(() => driver.parseWebhookEvent(body, 'ts=1;h1=deadbeef'))
  })
    .timeout(45_000)
    .skip(!SHOULD_RUN, 'PADDLE_TEST_API_KEY not set — Paddle smoke test skipped')

  test('live price lookup + checkout session (needs PADDLE_TEST_PRICE_ID)', async ({ assert }) => {
    configurePaddle({ [PRICE_ID!]: 'pro' })
    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()
    await billing.verify()

    const runId = randomUUID().slice(0, 8)

    // --- prices.retrieve (backs the agnostic price allowlist fallback) ---
    const driver = await getActiveBillingDriver()
    assert.isTrue(driver.supports('price_lookup'))
    const price = await driver.resolvePriceProduct!(PRICE_ID!)
    assert.equal(price?.id, PRICE_ID, 'Paddle returned the price')

    // --- ensureCustomer + transactions.create (hosted checkout URL) ---
    const tenant = await createTestTenant()
    cleanupTenants.push(tenant.id)
    const fakeTenant = {
      id: tenant.id,
      name: tenant.name ?? `paddle smoke ${runId}`,
      email: `paddle-checkout+${runId}@example.test`,
    } as unknown as TenantModelContract

    const checkout = await billing.createCheckoutSession(fakeTenant, {
      priceId: PRICE_ID!,
      successUrl: 'https://example.test/billing/ok',
      cancelUrl: 'https://example.test/billing/cancel',
    })
    assert.isString(checkout.id)
    assert.match(checkout.url, /^https?:\/\//, 'Paddle returned a checkout URL')
  })
    .timeout(45_000)
    .skip(
      !HAS_PRICE,
      'PADDLE_TEST_API_KEY/PADDLE_TEST_PRICE_ID not set — Paddle checkout smoke skipped'
    )
})
