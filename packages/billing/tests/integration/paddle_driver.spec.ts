import { test } from '@japa/runner'
import { createHmac } from 'node:crypto'
import { PaddleDriver } from '@adonisjs-lasagna/billing'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { testConfig } from '@adonisjs-lasagna/satellite-test-kit/testing'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Exercises the Paddle driver's REST call-sites + webhook scheme against a
 * stubbed `fetch` — no network, no credentials. Runs unconditionally in the
 * integration suite (the gated `paddle_real_smoke` spec only runs with a
 * sandbox key), so the driver's methods are actually executed and counted by
 * the aggregate coverage report.
 */
const WEBHOOK_SECRET = 'pdl_ntfset_test_secret'

function configurePaddle(webhookSecret = WEBHOOK_SECRET): void {
  setConfig({
    ...testConfig,
    billing: {
      driver: 'paddle',
      paddle: { apiKey: 'pdl_test_key', webhookSecret, environment: 'sandbox' },
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
    id: over.id ?? 'tnt_paddle',
    name: over.name ?? 'Acme',
    email: 'email' in over ? over.email : 'acme@example.test',
  } as unknown as TenantModelContract
}

test.group('PaddleDriver (stubbed fetch)', (group) => {
  let originalConfig: ReturnType<typeof getConfig>
  let originalFetch: typeof globalThis.fetch

  group.each.setup(() => {
    originalConfig = getConfig()
    originalFetch = globalThis.fetch
    configurePaddle()
  })

  group.each.teardown(() => {
    globalThis.fetch = originalFetch
    setConfig(originalConfig)
  })

  function stub(handler: (url: string, init: RequestInit | undefined) => Response): void {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(handler(String(input), init))) as typeof globalThis.fetch
  }

  test('reports its capabilities', ({ assert }) => {
    const d = new PaddleDriver()
    assert.isTrue(d.supports('checkout'))
    assert.isTrue(d.supports('price_lookup'))
    assert.isTrue(d.supports('subscription_cancel'))
    assert.isTrue(d.supports('subscription_list'))
    assert.isFalse(d.supports('billing_portal'))
    assert.isFalse(d.supports('usage_metering'))
  })

  test('listSubscriptions follows pagination and maps to neutral subscriptions', async ({
    assert,
  }) => {
    const urls: string[] = []
    stub((url) => {
      urls.push(url)
      if (urls.length === 1) {
        return jsonResponse({
          data: [
            {
              id: 'sub_1',
              customer_id: 'ctm_1',
              status: 'active',
              items: [{ price: { id: 'pri_1', product_id: 'pro_1' } }],
            },
          ],
          meta: {
            pagination: {
              has_more: true,
              next: 'https://sandbox-api.paddle.com/subscriptions?after=sub_1&per_page=100',
            },
          },
        })
      }
      return jsonResponse({
        data: [{ id: 'sub_2', customer_id: 'ctm_1', status: 'canceled', items: [] }],
        meta: { pagination: { has_more: false, next: null } },
      })
    })

    const ids: string[] = []
    for await (const sub of new PaddleDriver().listSubscriptions({ customerId: 'ctm_1' })) {
      ids.push(sub.providerSubscriptionId)
    }

    assert.deepEqual(ids, ['sub_1', 'sub_2'])
    assert.match(urls[0], /^https:\/\/sandbox-api\.paddle\.com\/subscriptions\?/)
    assert.match(urls[0], /per_page=100/)
    assert.match(urls[0], /customer_id=ctm_1/)
    assert.equal(
      urls[1],
      'https://sandbox-api.paddle.com/subscriptions?after=sub_1&per_page=100',
      'followed the absolute next URL'
    )
  })

  test('verifyConfig rejects an empty webhook secret', async ({ assert }) => {
    configurePaddle('')
    await assert.rejects(() => new PaddleDriver().verifyConfig(), /webhookSecret is empty/)
  })

  test('ensureCustomer POSTs to /customers (sandbox base url) and maps the id', async ({
    assert,
  }) => {
    let captured: { url: string; method?: string } | null = null
    stub((url, init) => {
      captured = { url, method: init?.method }
      return jsonResponse({ data: { id: 'ctm_123' } })
    })
    const customer = await new PaddleDriver().ensureCustomer(fakeTenant())
    assert.equal(customer.providerCustomerId, 'ctm_123')
    assert.match(captured!.url, /^https:\/\/sandbox-api\.paddle\.com\/customers$/)
    assert.equal(captured!.method, 'POST')
  })

  test('ensureCustomer sends an Idempotency-Key header so concurrent creates converge', async ({
    assert,
  }) => {
    let headers: Record<string, string> | undefined
    stub((_url, init) => {
      headers = init?.headers as Record<string, string> | undefined
      return jsonResponse({ data: { id: 'ctm_x' } })
    })
    await new PaddleDriver().ensureCustomer(fakeTenant({ id: 'tnt_abc' }))
    assert.equal(headers?.['Idempotency-Key'], 'tenant:tnt_abc:create-customer')
  })

  test('ensureCustomer throws when the tenant has no email', async ({ assert }) => {
    await assert.rejects(
      () => new PaddleDriver().ensureCustomer(fakeTenant({ email: null })),
      /requires an email/
    )
  })

  test('createCheckoutSession returns the hosted url', async ({ assert }) => {
    stub(() => jsonResponse({ data: { id: 'txn_1', checkout: { url: 'https://pay.paddle/abc' } } }))
    const r = await new PaddleDriver().createCheckoutSession(fakeTenant(), 'ctm_1', {
      priceId: 'pri_1',
      successUrl: 'https://ok',
      cancelUrl: 'https://no',
    })
    assert.equal(r.id, 'txn_1')
    assert.match(r.url, /^https:\/\//)
  })

  test('createCheckoutSession throws when Paddle returns no checkout url', async ({ assert }) => {
    stub(() => jsonResponse({ data: { id: 'txn_1', checkout: {} } }))
    await assert.rejects(
      () =>
        new PaddleDriver().createCheckoutSession(fakeTenant(), 'ctm_1', {
          priceId: 'pri_1',
          successUrl: 'https://ok',
          cancelUrl: 'https://no',
        }),
      /did not return a checkout URL/
    )
  })

  test('resolvePriceProduct maps a price to its product', async ({ assert }) => {
    stub(() => jsonResponse({ data: { id: 'pri_1', product_id: 'pro_1' } }))
    const price = await new PaddleDriver().resolvePriceProduct('pri_1')
    assert.deepEqual(price, { id: 'pri_1', productId: 'pro_1' })
  })

  test('cancelSubscription sends the right effective_from window', async ({ assert }) => {
    const bodies: Array<{ effective_from?: string }> = []
    stub((_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return jsonResponse({ data: {} })
    })
    const d = new PaddleDriver()
    await d.cancelSubscription('sub_1')
    await d.cancelSubscription('sub_1', { atPeriodEnd: true })
    assert.equal(bodies[0].effective_from, 'immediately')
    assert.equal(bodies[1].effective_from, 'next_billing_period')
  })

  test('a non-2xx response surfaces a mapped billing error', async ({ assert }) => {
    stub(() => jsonResponse({ error: { detail: 'unauthorized' } }, 401))
    await assert.rejects(
      () => new PaddleDriver().resolvePriceProduct('pri_x'),
      /Paddle API .* failed/
    )
  })

  test('a transport failure maps to a network error', async ({ assert }) => {
    globalThis.fetch = (() => {
      throw new Error('econnrefused')
    }) as typeof globalThis.fetch
    await assert.rejects(
      () => new PaddleDriver().resolvePriceProduct('pri_x'),
      /Paddle API connection error/
    )
  })

  test('verifyWebhookSignature + parseWebhookEvent round-trip a subscription event', async ({
    assert,
  }) => {
    const d = new PaddleDriver()
    const body = JSON.stringify({
      event_id: 'ntf_1',
      event_type: 'subscription.created',
      occurred_at: '2024-01-01T00:00:00Z',
      data: {
        id: 'sub_1',
        customer_id: 'ctm_1',
        status: 'active',
        current_billing_period: {
          starts_at: '2024-01-01T00:00:00Z',
          ends_at: '2024-02-01T00:00:00Z',
        },
        items: [{ price: { id: 'pri_1', product_id: 'pro_1' } }],
      },
    })
    const ts = Math.floor(Date.now() / 1000).toString()
    const h1 = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}:${body}`, 'utf8').digest('hex')
    const signature = `ts=${ts};h1=${h1}`

    assert.isTrue(d.verifyWebhookSignature(body, signature))
    assert.isFalse(d.verifyWebhookSignature(body, null), 'no header → reject')
    assert.isFalse(d.verifyWebhookSignature(body, 'ts=1;h1=deadbeef'), 'stale timestamp → reject')

    const event = await d.parseWebhookEvent(body, signature)
    assert.equal(event.provider, 'paddle')
    assert.equal(event.type, 'subscription.upsert')
    assert.equal((event.data as { providerSubscriptionId: string }).providerSubscriptionId, 'sub_1')

    await assert.rejects(() => d.parseWebhookEvent(body, 'ts=1;h1=deadbeef'), /signature mismatch/)
  })

  test('parseWebhookEvent maps a completed transaction to payment.succeeded', async ({
    assert,
  }) => {
    const d = new PaddleDriver()
    const body = JSON.stringify({
      event_id: 'ntf_2',
      event_type: 'transaction.completed',
      occurred_at: '2024-01-01T00:00:00Z',
      data: {
        id: 'txn_1',
        customer_id: 'ctm_1',
        subscription_id: 'sub_1',
        currency_code: 'USD',
        details: { totals: { grand_total: '1000' } },
      },
    })
    const ts = Math.floor(Date.now() / 1000).toString()
    const h1 = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}:${body}`, 'utf8').digest('hex')
    const event = await d.parseWebhookEvent(body, `ts=${ts};h1=${h1}`)
    assert.equal(event.type, 'payment.succeeded')
  })
})
