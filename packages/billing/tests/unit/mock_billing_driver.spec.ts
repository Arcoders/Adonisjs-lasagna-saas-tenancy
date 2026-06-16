import { test } from '@japa/runner'
import MockBillingDriver from '../../src/testing/mock_billing_driver.js'
import type { BillingWebhookEvent } from '../../src/contracts/types.js'

test.group('MockBillingDriver — contract round-trip', () => {
  test('signs + verifies + parses a webhook body back to a neutral event', async ({ assert }) => {
    const driver = new MockBillingDriver({ webhookSecret: 'whsec_test' })
    const event: Omit<BillingWebhookEvent, 'provider'> = {
      id: 'evt_mock_1',
      createdAt: 1_700_000_000,
      nativeType: 'subscription.created',
      type: 'subscription.upsert',
      data: {
        providerSubscriptionId: 'sub_1',
        customerId: 'cus_1',
        status: 'active',
        currentPeriodStart: 1,
        currentPeriodEnd: 2,
        cancelAtPeriodEnd: false,
        cancelAt: null,
        canceledAt: null,
        trialEnd: null,
        productId: 'prod_1',
        priceId: 'price_1',
        raw: {},
      },
    }
    const body = JSON.stringify(event)
    const sig = driver.signMockWebhook(body)

    assert.isTrue(driver.verifyWebhookSignature(body, sig))
    assert.isFalse(driver.verifyWebhookSignature(body, 'deadbeef'))
    assert.isFalse(driver.verifyWebhookSignature(body, null))

    const parsed = await driver.parseWebhookEvent(body, sig)
    assert.equal(parsed.provider, 'mock')
    assert.equal(parsed.type, 'subscription.upsert')
    assert.equal((parsed.data as any).providerSubscriptionId, 'sub_1')
  })

  test('rejects a tampered body with invalid_signature', async ({ assert }) => {
    const driver = new MockBillingDriver({ webhookSecret: 'whsec_test' })
    const sig = driver.signMockWebhook('{"a":1}')
    await assert.rejects(() => driver.parseWebhookEvent('{"a":2}', sig), /signature/)
  })

  test('records usage and reports all capabilities supported', async ({ assert }) => {
    const driver = new MockBillingDriver()
    assert.isTrue(driver.supports('usage_metering'))
    await driver.reportUsage('cus_1', { eventName: 'api_calls' }, 5, {
      idempotencyKey: 'k1',
      timestampSeconds: 100,
    })
    assert.lengthOf(driver.usage, 1)
    assert.equal(driver.usage[0].quantity, 5)
    assert.equal(driver.usage[0].eventName, 'api_calls')
  })

  test('retrieveEvent returns injected events for the tamper-guard path', async ({ assert }) => {
    const driver = new MockBillingDriver()
    const event = {
      id: 'evt_inj',
      createdAt: 1,
      provider: 'mock' as const,
      nativeType: 'x',
      type: 'unknown' as const,
      data: {},
    }
    driver.injectEvent(event)
    assert.deepEqual(await driver.retrieveEvent('evt_inj'), event)
    assert.isNull(await driver.retrieveEvent('missing'))
  })
})
