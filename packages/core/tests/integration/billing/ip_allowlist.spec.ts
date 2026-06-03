import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { BillingService } from '@adonisjs-lasagna/billing'
import { VerifyStripeWebhookMiddleware } from '@adonisjs-lasagna/billing'
import { MockStripe, signWebhookPayload } from '@adonisjs-lasagna/billing'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { buildEvent, buildSubscription, clearBillingTables } from './helpers.js'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

/**
 * Middleware-level coverage. Imports `VerifyStripeWebhookMiddleware`
 * via the package path (build), so the middleware shares the booted
 * provider's `_config` singleton. Importing it from `../../../src/...`
 * loads a separate module instance whose `_config` is null at runtime
 * (the provider booted from build/ never wrote to it) and every test
 * fails with "saas-tenancy not configured".
 *
 * Helper-level CIDR/IPv6/literal/malformed coverage lives in
 * `tests/unit/services/billing/stripe_ip_allowlist.spec.ts`.
 */
test.group('IP allowlist — middleware integration', (group) => {
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(async () => {
    originalConfig = getConfig()
    await clearBillingTables()
  })

  group.each.teardown(async () => {
    setConfig(originalConfig)
    const billing = await app.container.make(BillingService)
    billing.__resetForTests()
  })

  function withAllowlist(allowedIps: string[]): void {
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
        webhook: { enforceIpAllowlist: true, allowedIps },
      },
    } as never)
  }

  /**
   * Build a minimal HttpContext-shape that the middleware actually uses.
   * Only `request.ip()`, `request.header()`, `request.raw()` and
   * `response.unauthorized()` are exercised — anything else surfaces as
   * a TypeError (deliberate: the test fails loud on unexpected access).
   */
  interface FakeFixture {
    ctx: HttpContext
    response: { status: number | null; body: unknown }
    next: NextFn
    nextCalled: () => boolean
  }
  function fakeContext(opts: { ip: string; signature?: string; body?: string }): FakeFixture {
    const responseBox = { status: null as number | null, body: null as unknown }
    let nextCalled = false
    const ctx = {
      request: {
        ip: () => opts.ip,
        header: (name: string) =>
          name.toLowerCase() === 'stripe-signature' ? opts.signature : undefined,
        raw: () => opts.body ?? null,
      },
      response: {
        unauthorized: (body: unknown) => {
          responseBox.status = 401
          responseBox.body = body
          return responseBox
        },
      },
    } as unknown as HttpContext
    const next = (async () => {
      nextCalled = true
    }) as NextFn
    return { ctx, response: responseBox, next, nextCalled: () => nextCalled }
  }

  test('blocked IP → 401, never reaches signature verification', async ({ assert }) => {
    withAllowlist(['203.0.113.1'])
    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const fake = fakeContext({ ip: '10.0.0.1' })
    const middleware = new VerifyStripeWebhookMiddleware()
    await middleware.handle(fake.ctx, fake.next)

    assert.equal(fake.response.status, 401, 'rejected before signature check')
    assert.isFalse(fake.nextCalled(), 'next() never called')
  })

  test('IP in literal list → middleware progresses to signature verification', async ({
    assert,
  }) => {
    withAllowlist(['10.0.0.5'])
    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const event = buildEvent('customer.subscription.created', buildSubscription())
    const body = JSON.stringify(event)
    const sig = signWebhookPayload(body, 'whsec_test_billing_helper')

    const fake = fakeContext({ ip: '10.0.0.5', signature: sig, body })
    const middleware = new VerifyStripeWebhookMiddleware()
    await middleware.handle(fake.ctx, fake.next)

    assert.isNull(fake.response.status, 'no 401 — middleware passed')
    assert.isTrue(fake.nextCalled(), 'next() invoked')
  })

  test('IP in CIDR /24 → middleware allows', async ({ assert }) => {
    withAllowlist(['10.0.0.0/24'])
    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const event = buildEvent('customer.subscription.created', buildSubscription())
    const body = JSON.stringify(event)
    const sig = signWebhookPayload(body, 'whsec_test_billing_helper')

    const fake = fakeContext({ ip: '10.0.0.42', signature: sig, body })
    const middleware = new VerifyStripeWebhookMiddleware()
    await middleware.handle(fake.ctx, fake.next)

    assert.isNull(fake.response.status)
    assert.isTrue(fake.nextCalled())
  })

  test('malformed remote IP rejected with 401, not 500', async ({ assert }) => {
    withAllowlist(['10.0.0.0/24'])
    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))

    const fake = fakeContext({ ip: 'definitely-not-an-ip' })
    const middleware = new VerifyStripeWebhookMiddleware()
    await middleware.handle(fake.ctx, fake.next)

    assert.equal(fake.response.status, 401)
    assert.isFalse(fake.nextCalled())
  })
})
