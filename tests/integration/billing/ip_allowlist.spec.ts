import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { BillingService } from '@adonisjs-lasagna/saas-tenancy/services'
import { MockStripe, signWebhookPayload } from '@adonisjs-lasagna/saas-tenancy/testing'
import VerifyStripeWebhookMiddleware from '../../../src/middleware/verify_stripe_webhook_middleware.js'
import {
  isStripeWebhookOriginAllowed,
  __resetIpAllowlistCache,
} from '../../../src/services/billing/stripe_ip_allowlist.js'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, buildEvent, buildSubscription, clearBillingTables } from './helpers.js'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

/**
 * Two layers of coverage:
 *
 *   1. Helper unit-level: literal/CIDR/IPv6-mapped/malformed forms in
 *      `isStripeWebhookOriginAllowed`. Cheap, fast, exhaustive.
 *
 *   2. Middleware-level: the helper integration via
 *      `VerifyStripeWebhookMiddleware.handle()`. We feed a stub
 *      HttpContext with a controlled `request.ip()` and observe whether
 *      the middleware short-circuits with 401 before the signature step
 *      (or progresses to next() when the IP passes).
 *
 * Layer 2 is what catches a regression where a future refactor stops
 * calling `isStripeWebhookOriginAllowed` from the middleware (helper
 * works, middleware skips it, tests still pass under helper-only).
 */
test.group('IP allowlist — helper (CIDR/IPv6/malformed)', (group) => {
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(async () => {
    originalConfig = getConfig()
    await clearBillingTables()
    __resetIpAllowlistCache()
  })

  group.each.teardown(() => {
    setConfig(originalConfig)
    __resetIpAllowlistCache()
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
    __resetIpAllowlistCache()
  }

  test('off by default: every IP allowed when enforce flag is unset', ({ assert }) => {
    setupBillingConfig({ defaultPlan: 'starter' })
    assert.isTrue(isStripeWebhookOriginAllowed('1.2.3.4'))
    assert.isTrue(isStripeWebhookOriginAllowed(undefined))
    assert.isTrue(isStripeWebhookOriginAllowed('::1'))
  })

  test('literal IPv4 match', ({ assert }) => {
    withAllowlist(['54.187.174.169', '54.187.205.235'])
    assert.isTrue(isStripeWebhookOriginAllowed('54.187.174.169'))
    assert.isTrue(isStripeWebhookOriginAllowed('54.187.205.235'))
    assert.isFalse(isStripeWebhookOriginAllowed('54.187.174.170'))
  })

  test('CIDR /24 — IP inside range matches, outside does not', ({ assert }) => {
    withAllowlist(['54.187.174.0/24'])
    assert.isTrue(isStripeWebhookOriginAllowed('54.187.174.1'))
    assert.isTrue(isStripeWebhookOriginAllowed('54.187.174.255'))
    assert.isFalse(isStripeWebhookOriginAllowed('54.187.175.0'))
  })

  test('mixed literal + CIDR list', ({ assert }) => {
    withAllowlist(['10.0.0.5', '192.168.0.0/16'])
    assert.isTrue(isStripeWebhookOriginAllowed('10.0.0.5'))
    assert.isTrue(isStripeWebhookOriginAllowed('192.168.42.42'))
    assert.isFalse(isStripeWebhookOriginAllowed('10.0.0.6'))
    assert.isFalse(isStripeWebhookOriginAllowed('172.16.0.1'))
  })

  test('IPv4-mapped IPv6 normalised then matched against IPv4 entry', ({ assert }) => {
    withAllowlist(['54.187.174.169'])
    assert.isTrue(isStripeWebhookOriginAllowed('::ffff:54.187.174.169'))
  })

  test('malformed IP rejected without throwing', ({ assert }) => {
    withAllowlist(['10.0.0.1'])
    assert.isFalse(isStripeWebhookOriginAllowed('not-an-ip'))
    assert.isFalse(isStripeWebhookOriginAllowed(''))
  })

  test('empty allowedIps with enforce on rejects everything (fail-closed)', ({ assert }) => {
    withAllowlist([])
    assert.isFalse(isStripeWebhookOriginAllowed('10.0.0.1'))
    assert.isFalse(isStripeWebhookOriginAllowed(undefined))
  })
})

test.group('IP allowlist — middleware integration', (group) => {
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(async () => {
    originalConfig = getConfig()
    await clearBillingTables()
    __resetIpAllowlistCache()
  })

  group.each.teardown(async () => {
    setConfig(originalConfig)
    __resetIpAllowlistCache()
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
    __resetIpAllowlistCache()
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
  function fakeContext(opts: {
    ip: string
    signature?: string
    body?: string
  }): FakeFixture {
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
