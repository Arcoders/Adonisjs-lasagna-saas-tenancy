import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { BillingService } from '@adonisjs-lasagna/billing'
import { VerifyBillingWebhookMiddleware } from '@adonisjs-lasagna/billing'
import { MockStripe, signWebhookPayload } from '@adonisjs-lasagna/billing'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { buildEvent, buildSubscription, clearBillingTables } from './helpers.js'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

/**
 * Webhook verification negative paths, driven through
 * `VerifyBillingWebhookMiddleware` (imported via the package build so it shares
 * the booted provider's config singleton — see ip_allowlist.spec for why). A
 * request that fails verification MUST reject with a mapped `BillingException`
 * and never call `next()`, so the controller never stamps a ledger row or
 * dispatches a job. Tamper/HMAC rejection itself is covered at the driver level
 * (real HMAC) in the paddle/lemon_squeezy driver specs + `signWebhookPayload`.
 */
const SECRET = 'whsec_test_billing_helper'

test.group('Webhook verification — negative paths', (group) => {
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(async () => {
    originalConfig = getConfig()
    await clearBillingTables()
    setConfig({
      ...originalConfig,
      plans: {
        defaultPlan: 'starter',
        definitions: { starter: { limits: {} } },
        storage: 'tenant_plans',
      },
      billing: {
        driver: 'stripe',
        stripe: { apiKey: 'sk_test_x', webhookSecret: SECRET },
        products: { prod_starter: 'starter' },
        defaultPlan: 'starter',
        // IP allowlist off → requests reach signature verification.
      },
    } as never)
    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe(SECRET))
  })

  group.each.teardown(async () => {
    setConfig(originalConfig)
    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()
  })

  function fakeContext(opts: { signature?: string; body?: string }): HttpContext {
    return {
      request: {
        ip: () => '127.0.0.1',
        header: (name: string) =>
          name.toLowerCase() === 'stripe-signature' ? opts.signature : undefined,
        raw: () => opts.body ?? null,
      },
      response: {
        unauthorized: () => {
          throw new Error('response.unauthorized should not be reached in these cases')
        },
      },
    } as unknown as HttpContext
  }

  /** Run the middleware, capturing any thrown error + whether next() ran. */
  async function run(
    ctx: HttpContext
  ): Promise<{ billingCode?: string; message: string; nextCalled: boolean }> {
    let nextCalled = false
    const next = (async () => {
      nextCalled = true
    }) as NextFn
    try {
      await new VerifyBillingWebhookMiddleware().handle(ctx, next)
      return { message: '__no_error_thrown__', nextCalled }
    } catch (err) {
      return {
        billingCode: (err as { billingCode?: string }).billingCode,
        message: (err as Error).message,
        nextCalled,
      }
    }
  }

  test('missing stripe-signature header → invalid_signature, next never called', async ({
    assert,
  }) => {
    const body = JSON.stringify(buildEvent('customer.subscription.created', buildSubscription()))
    const r = await run(fakeContext({ body })) // no signature

    assert.equal(r.billingCode, 'invalid_signature')
    assert.match(r.message, /missing stripe-signature/i)
    assert.isFalse(r.nextCalled, 'never dispatched')
  })

  test('garbage signature header → invalid_signature, next never called', async ({ assert }) => {
    const body = JSON.stringify(buildEvent('customer.subscription.created', buildSubscription()))
    const r = await run(fakeContext({ body, signature: 'totally-not-a-stripe-signature' }))

    assert.equal(r.billingCode, 'invalid_signature')
    assert.isFalse(r.nextCalled)
  })

  test('an unparseable body (even validly signed) is rejected, never dispatched', async ({
    assert,
  }) => {
    const body = '{ this is not valid json'
    const r = await run(fakeContext({ body, signature: signWebhookPayload(body, SECRET) }))

    assert.notEqual(r.message, '__no_error_thrown__', 'unparseable body surfaces a mapped error')
    assert.isFalse(r.nextCalled, 'never dispatched')
  })

  test('empty body → webhook_body_unreadable, next never called', async ({ assert }) => {
    const r = await run(fakeContext({ body: undefined, signature: signWebhookPayload('', SECRET) }))

    assert.equal(r.billingCode, 'webhook_body_unreadable')
    assert.isFalse(r.nextCalled)
  })
})
