import { test } from '@japa/runner'
import { createHmac } from 'node:crypto'
import { LemonSqueezyDriver } from '@adonisjs-lasagna/billing'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { testConfig } from '@adonisjs-lasagna/satellite-test-kit/testing'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Exercises the Lemon Squeezy driver's JSON:API call-sites + `X-Signature`
 * webhook scheme against a stubbed `fetch`. Runs unconditionally (the gated
 * `lemon_squeezy_real_smoke` spec needs a test store), so the driver methods
 * are executed and counted by the aggregate coverage report.
 */
const WEBHOOK_SECRET = 'lsq_test_secret'

function configureLemonSqueezy(
  over: Partial<{ webhookSecret: string; storeId: string }> = {}
): void {
  setConfig({
    ...testConfig,
    billing: {
      driver: 'lemonsqueezy',
      lemonSqueezy: {
        apiKey: 'ls_test_key',
        webhookSecret: over.webhookSecret ?? WEBHOOK_SECRET,
        storeId: over.storeId ?? '42',
      },
      products: {},
      defaultPlan: 'starter',
    },
  } as never)
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    statusText: 'stub',
    json: async () => body,
  } as unknown as Response
}

function fakeTenant(
  over: Partial<{ id: string; name: string; email: string | null }> = {}
): TenantModelContract {
  return {
    id: over.id ?? 'tnt_ls',
    name: over.name ?? 'Acme',
    email: 'email' in over ? over.email : 'acme@example.test',
  } as unknown as TenantModelContract
}

test.group('LemonSqueezyDriver (stubbed fetch)', (group) => {
  let originalConfig: ReturnType<typeof getConfig>
  let originalFetch: typeof globalThis.fetch

  group.each.setup(() => {
    originalConfig = getConfig()
    originalFetch = globalThis.fetch
    configureLemonSqueezy()
  })

  group.each.teardown(() => {
    globalThis.fetch = originalFetch
    setConfig(originalConfig)
  })

  function stub(handler: (url: string, init: RequestInit | undefined) => Response): void {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(handler(String(input), init))) as typeof globalThis.fetch
  }

  test('reports its capabilities (no portal, no usage, no price lookup)', ({ assert }) => {
    const d = new LemonSqueezyDriver()
    assert.isTrue(d.supports('checkout'))
    assert.isTrue(d.supports('subscription_cancel'))
    assert.isTrue(d.supports('subscription_list'))
    assert.isFalse(d.supports('price_lookup'))
    assert.isFalse(d.supports('billing_portal'))
    assert.isFalse(d.supports('usage_metering'))
  })

  test('listSubscriptions pages through JSON:API and maps to neutral subscriptions', async ({
    assert,
  }) => {
    const urls: string[] = []
    stub((url) => {
      urls.push(url)
      if (urls.length === 1) {
        return jsonResponse({
          data: [
            {
              id: 1,
              attributes: {
                status: 'active',
                customer_id: 7,
                product_id: 3,
                variant_id: 9,
                created_at: '2024-01-01T00:00:00Z',
                renews_at: '2024-02-01T00:00:00Z',
              },
            },
          ],
          meta: { page: { lastPage: 2 } },
        })
      }
      return jsonResponse({
        data: [
          {
            id: 2,
            attributes: {
              status: 'cancelled',
              customer_id: 7,
              cancelled: true,
              created_at: '2024-01-01T00:00:00Z',
              updated_at: '2024-03-01T00:00:00Z',
              ends_at: '2024-04-01T00:00:00Z',
            },
          },
        ],
        meta: { page: { lastPage: 2 } },
      })
    })

    const ids: string[] = []
    for await (const sub of new LemonSqueezyDriver().listSubscriptions({ customerId: '7' })) {
      ids.push(sub.providerSubscriptionId)
    }

    assert.deepEqual(ids, ['1', '2'])
    assert.equal(urls.length, 2, 'followed pagination to the last page')
    const firstUrl = decodeURIComponent(urls[0]!)
    assert.match(firstUrl, /filter\[store_id\]=42/)
    assert.match(firstUrl, /filter\[customer_id\]=7/)
  })

  test('verifyConfig rejects an empty webhook secret and an empty store id', async ({ assert }) => {
    configureLemonSqueezy({ webhookSecret: '' })
    await assert.rejects(() => new LemonSqueezyDriver().verifyConfig(), /webhookSecret is empty/)
    configureLemonSqueezy({ storeId: '' })
    await assert.rejects(() => new LemonSqueezyDriver().verifyConfig(), /storeId is empty/)
  })

  test('ensureCustomer POSTs to the JSON:API and maps the numeric id to a string', async ({
    assert,
  }) => {
    let captured: { url: string; method?: string | undefined } | null = null
    stub((url, init) => {
      captured = { url, method: init?.method }
      return jsonResponse({ data: { id: 7 } })
    })
    const customer = await new LemonSqueezyDriver().ensureCustomer(fakeTenant())
    assert.equal(customer.providerCustomerId, '7')
    assert.match(captured!.url, /api\.lemonsqueezy\.com\/v1\/customers$/)
    assert.equal(captured!.method, 'POST')
  })

  test('ensureCustomer throws when the tenant has no email', async ({ assert }) => {
    await assert.rejects(
      () => new LemonSqueezyDriver().ensureCustomer(fakeTenant({ email: null })),
      /requires an email/
    )
  })

  test('ensureCustomer reuses a customer found by email (find-or-create, no POST)', async ({
    assert,
  }) => {
    const calls: string[] = []
    stub((url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      return jsonResponse({ data: [{ id: 7 }] }) // list endpoint returns an array
    })
    const customer = await new LemonSqueezyDriver().ensureCustomer(fakeTenant())
    assert.equal(customer.providerCustomerId, '7')
    assert.lengthOf(calls, 1, 'no POST — reused the existing customer')
    assert.match(calls[0]!, /^GET .*filter\[email\]/)
  })

  test('ensureCustomer reuses the winner on a 422 race (POST conflicts → re-GET finds it)', async ({
    assert,
  }) => {
    const seq: string[] = []
    let getCount = 0
    stub((_url, init) => {
      const method = init?.method ?? 'GET'
      seq.push(method)
      if (method === 'GET') {
        getCount += 1
        // First lookup misses; the lookup after the 422 finds the winner.
        return jsonResponse({ data: getCount === 1 ? [] : [{ id: 9 }] })
      }
      return jsonResponse({ errors: [{ detail: 'email has already been taken' }] }, 422)
    })
    const customer = await new LemonSqueezyDriver().ensureCustomer(fakeTenant())
    assert.equal(customer.providerCustomerId, '9')
    assert.deepEqual(seq, ['GET', 'POST', 'GET'])
  })

  test('createCheckoutSession returns the hosted url from attributes', async ({ assert }) => {
    stub(() =>
      jsonResponse({ data: { id: 'co_1', attributes: { url: 'https://store.ls/checkout' } } })
    )
    const r = await new LemonSqueezyDriver().createCheckoutSession(fakeTenant(), 'cust_unused', {
      priceId: '9',
      successUrl: 'https://ok',
      cancelUrl: 'https://no',
    })
    assert.equal(r.id, 'co_1')
    assert.match(r.url, /^https:\/\//)
  })

  test('createCheckoutSession throws when LS returns no url', async ({ assert }) => {
    stub(() => jsonResponse({ data: { id: 'co_1', attributes: {} } }))
    await assert.rejects(
      () =>
        new LemonSqueezyDriver().createCheckoutSession(fakeTenant(), 'cust_unused', {
          priceId: '9',
          successUrl: 'https://ok',
          cancelUrl: 'https://no',
        }),
      /did not return a checkout URL/
    )
  })

  test('cancelSubscription issues a DELETE and tolerates a 204', async ({ assert }) => {
    let captured: { url: string; method?: string | undefined } | null = null
    stub((url, init) => {
      captured = { url, method: init?.method }
      return jsonResponse(undefined, 204)
    })
    await new LemonSqueezyDriver().cancelSubscription('sub_1')
    assert.match(captured!.url, /\/subscriptions\/sub_1$/)
    assert.equal(captured!.method, 'DELETE')
  })

  test('a non-2xx response surfaces a mapped billing error', async ({ assert }) => {
    stub(() => jsonResponse({ errors: [{ detail: 'forbidden' }] }, 403))
    await assert.rejects(
      () => new LemonSqueezyDriver().ensureCustomer(fakeTenant()),
      /Lemon Squeezy API .* failed/
    )
  })

  test('a transport failure maps to a network error', async ({ assert }) => {
    globalThis.fetch = (() => {
      throw new Error('econnrefused')
    }) as typeof globalThis.fetch
    await assert.rejects(
      () => new LemonSqueezyDriver().ensureCustomer(fakeTenant()),
      /Lemon Squeezy API connection error/
    )
  })

  test('verifyWebhookSignature + parseWebhookEvent round-trip a subscription event', async ({
    assert,
  }) => {
    const d = new LemonSqueezyDriver()
    const body = JSON.stringify({
      meta: { event_name: 'subscription_created' },
      data: {
        id: 42,
        attributes: {
          status: 'active',
          customer_id: 7,
          product_id: 3,
          variant_id: 9,
          created_at: '2024-01-01T00:00:00Z',
          renews_at: '2024-02-01T00:00:00Z',
        },
      },
    })
    const signature = createHmac('sha256', WEBHOOK_SECRET).update(body, 'utf8').digest('hex')

    assert.isTrue(d.verifyWebhookSignature(body, signature))
    assert.isFalse(d.verifyWebhookSignature(body, null))

    const event = await d.parseWebhookEvent(body, signature)
    assert.equal(event.provider, 'lemonsqueezy')
    assert.equal(event.type, 'subscription.upsert')
    assert.equal((event.data as { providerSubscriptionId: string }).providerSubscriptionId, '42')

    await assert.rejects(() => d.parseWebhookEvent(body, 'deadbeef'), /signature mismatch/)
  })

  function lsSubscriptionBody(tenantId: string): string {
    return JSON.stringify({
      meta: { event_name: 'subscription_created', custom_data: { tenant_id: tenantId } },
      data: {
        id: 42,
        attributes: {
          status: 'active',
          customer_id: 7,
          product_id: 3,
          variant_id: 9,
          created_at: '2024-01-01T00:00:00Z',
          renews_at: '2024-02-01T00:00:00Z',
        },
      },
    })
  }

  // Lemon Squeezy's webhook HMAC carries no timestamp, so there is no replay
  // window like Stripe's/Paddle's 300s tolerance. The mitigation is the
  // synthetic event id derived from sha256(rawBody): a leaked secret only lets
  // an attacker replay BYTE-IDENTICAL bodies, which the idempotency ledger
  // already collapses via `ON CONFLICT (event_id) DO NOTHING`. These two tests
  // pin that property so a future mapper change can't silently regress it.
  test('replay window: identical bodies collapse to one synthetic event id', async ({ assert }) => {
    const d = new LemonSqueezyDriver()
    const body = lsSubscriptionBody('tnt_a')
    const sig = createHmac('sha256', WEBHOOK_SECRET).update(body, 'utf8').digest('hex')

    const first = await d.parseWebhookEvent(body, sig)
    const second = await d.parseWebhookEvent(body, sig)

    assert.equal(first.id, second.id, 'same body → same id → the ledger dedupes the replay')
    assert.match(first.id, /^lsq_/)
  })

  test('replay window: distinct-tenant bodies do NOT collapse', async ({ assert }) => {
    const d = new LemonSqueezyDriver()
    const bodyA = lsSubscriptionBody('tnt_a')
    const bodyB = lsSubscriptionBody('tnt_b')

    const a = await d.parseWebhookEvent(
      bodyA,
      createHmac('sha256', WEBHOOK_SECRET).update(bodyA, 'utf8').digest('hex')
    )
    const b = await d.parseWebhookEvent(
      bodyB,
      createHmac('sha256', WEBHOOK_SECRET).update(bodyB, 'utf8').digest('hex')
    )

    assert.notEqual(a.id, b.id, 'different tenant in the body → different hash → both processed')
  })

  test('parseWebhookEvent maps a failed payment to payment.failed', async ({ assert }) => {
    const d = new LemonSqueezyDriver()
    const body = JSON.stringify({
      meta: { event_name: 'subscription_payment_failed' },
      data: {
        id: 100,
        attributes: { subscription_id: 42, customer_id: 7, total: 999, currency: 'USD' },
      },
    })
    const signature = createHmac('sha256', WEBHOOK_SECRET).update(body, 'utf8').digest('hex')
    const event = await d.parseWebhookEvent(body, signature)
    assert.equal(event.type, 'payment.failed')
  })
})
