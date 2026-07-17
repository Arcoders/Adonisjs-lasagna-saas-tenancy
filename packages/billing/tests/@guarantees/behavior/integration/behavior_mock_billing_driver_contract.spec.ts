import { test } from '@japa/runner'
import { MockBillingDriver } from '@adonisjs-lasagna/billing'
import type { BillingCapability, BillingWebhookEvent } from '@adonisjs-lasagna/billing'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Exercises the shipped in-memory MockBillingDriver end to end. It's re-exported
 * from the package index (so it loads during the integration run) but nothing
 * else calls its methods there. Driving it here keeps the test double itself
 * covered by the aggregate report, and double-checks the contract it advertises.
 */
const tenant = {
  id: 'tnt_mock',
  name: 'Acme',
  email: 'acme@example.test',
} as unknown as TenantModelContract

const ALL_CAPABILITIES: BillingCapability[] = [
  'checkout',
  'billing_portal',
  'usage_metering',
  'event_retrieval',
  'price_lookup',
  'subscription_cancel',
]

test.group('MockBillingDriver contract', () => {
  test('supports every capability', ({ assert }) => {
    const d = new MockBillingDriver()
    for (const cap of ALL_CAPABILITIES) assert.isTrue(d.supports(cap), `supports ${cap}`)
  })

  test('customer, checkout, portal, usage, cancel and health all work in memory', async ({
    assert,
  }) => {
    const d = new MockBillingDriver({ webhookSecret: 'whsec_mock_test' })
    await d.verifyConfig()

    const customer = await d.ensureCustomer(tenant)
    assert.equal(customer.providerCustomerId, 'cus_mock_tnt_mock')

    const checkout = await d.createCheckoutSession(tenant, customer.providerCustomerId, {
      priceId: 'price_1',
      successUrl: 'https://ok',
      cancelUrl: 'https://no',
    })
    assert.match(checkout.url, /mock\.test\/checkout/)
    assert.isString(checkout.id)

    const portal = await d.createBillingPortalSession(customer.providerCustomerId, {
      returnUrl: 'https://back',
    })
    assert.match(portal.url, /mock\.test\/portal/)

    await d.reportUsage(customer.providerCustomerId, { eventName: 'api_request' }, 5, {
      idempotencyKey: 'k1',
      timestampSeconds: 1_700_000_000,
    })
    assert.lengthOf(d.usage, 1)
    assert.equal(d.usage[0]?.quantity, 5)

    await d.cancelSubscription('sub_1', { atPeriodEnd: true })
    assert.deepEqual(d.canceled[0], { id: 'sub_1', atPeriodEnd: true })

    await d.healthCheck()
  })

  test('resolvePriceProduct returns injected mappings or null', async ({ assert }) => {
    const d = new MockBillingDriver()
    assert.isNull(await d.resolvePriceProduct('unknown'))
    d.injectPrice('price_1', 'prod_1')
    assert.deepEqual(await d.resolvePriceProduct('price_1'), { id: 'price_1', productId: 'prod_1' })
    d.injectPrice('price_2', null)
    assert.deepEqual(await d.resolvePriceProduct('price_2'), { id: 'price_2', productId: null })
  })

  test('signMockWebhook + parseWebhookEvent round-trip; a bad signature is rejected', async ({
    assert,
  }) => {
    const d = new MockBillingDriver({ webhookSecret: 'whsec_mock_test' })
    const body = JSON.stringify({
      id: 'evt_1',
      createdAt: 1_700_000_000,
      nativeType: 'subscription.created',
      type: 'subscription.upsert',
      data: { providerSubscriptionId: 'sub_1' },
    })
    const signature = d.signMockWebhook(body)

    assert.isTrue(d.verifyWebhookSignature(body, signature))
    assert.isFalse(d.verifyWebhookSignature(body, null))

    const event = await d.parseWebhookEvent(body, signature)
    assert.equal(event.provider, 'mock')
    assert.equal(event.type, 'subscription.upsert')

    await assert.rejects(() => d.parseWebhookEvent(body, 'deadbeef'), /signature mismatch/)
  })

  test('retrieveEvent returns an injected event or null', async ({ assert }) => {
    const d = new MockBillingDriver()
    assert.isNull(await d.retrieveEvent('missing'))
    const injected: BillingWebhookEvent = {
      id: 'evt_9',
      createdAt: 1_700_000_000,
      provider: 'mock',
      nativeType: 'charge.refunded',
      type: 'unknown',
      data: {},
    }
    d.injectEvent(injected)
    assert.deepEqual(await d.retrieveEvent('evt_9'), injected)
  })
})
