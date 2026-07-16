import { test } from '@japa/runner'
import {
  redactBillingEvent,
  toReplayablePayload,
  rebuildBillingEvent,
} from '../../../../src/services/billing/redact.js'
import type { BillingWebhookEvent } from '../../../../src/contracts/types.js'

function subEvent(): BillingWebhookEvent {
  return {
    id: 'evt_1',
    createdAt: 1_700_000_000,
    provider: 'stripe',
    nativeType: 'customer.subscription.updated',
    type: 'subscription.upsert',
    data: {
      providerSubscriptionId: 'sub_abc',
      customerId: 'cus_abc',
      status: 'active',
      currentPeriodStart: 1_700_000_000,
      currentPeriodEnd: 1_702_592_000,
      cancelAtPeriodEnd: true,
      cancelAt: 1_700_500_000,
      canceledAt: null,
      trialEnd: 1_700_300_000,
      productId: 'prod_pro',
      priceId: 'price_pro_monthly',
      // PII landmines live only in the provider raw blob.
      raw: { metadata: { secret: 'TOP-SECRET' }, customer_email: 'user@example.com' },
    },
  }
}

test.group('redactBillingEvent — log-safe projection', () => {
  test('emits only safe fields for a subscription event', ({ assert }) => {
    const safe = redactBillingEvent(subEvent())
    assert.equal(safe.id, 'evt_1')
    assert.equal(safe.type, 'subscription.upsert')
    assert.equal(safe.provider, 'stripe')
    assert.equal(safe.subscription_id, 'sub_abc')
    assert.equal(safe.customer_id, 'cus_abc')
    assert.equal(safe.status, 'active')
    const json = JSON.stringify(safe)
    assert.notInclude(json, 'TOP-SECRET')
    assert.notInclude(json, 'user@example.com')
  })

  test('captures invoice amount + currency for payment events', ({ assert }) => {
    const safe = redactBillingEvent({
      id: 'evt_2',
      createdAt: 1,
      provider: 'stripe',
      nativeType: 'invoice.payment_failed',
      type: 'payment.failed',
      data: {
        id: 'in_z',
        customerId: 'cus_z',
        subscriptionId: 'sub_z',
        amountPaid: 0,
        amountDue: 4200,
        currency: 'eur',
        attemptCount: 3,
        nextPaymentAttempt: null,
      },
    })
    assert.equal(safe.customer_id, 'cus_z')
    assert.equal(safe.subscription_id, 'sub_z')
    assert.equal(safe.amount, 4200)
    assert.equal(safe.currency, 'eur')
  })
})

test.group('toReplayablePayload — strips the provider raw blob', () => {
  test('drops raw, keeps the structural fields the dispatcher reads', ({ assert }) => {
    const payload = toReplayablePayload(subEvent()) as any
    assert.equal(payload.id, 'evt_1')
    assert.equal(payload.type, 'subscription.upsert')
    assert.equal(payload.data.productId, 'prod_pro')
    assert.equal(payload.data.priceId, 'price_pro_monthly')
    assert.equal(payload.data.status, 'active')
    assert.deepEqual(payload.data.raw, {})
    const json = JSON.stringify(payload)
    assert.notInclude(json, 'TOP-SECRET')
    assert.notInclude(json, 'user@example.com')
  })

  test('passes non-subscription events through unchanged (no raw to strip)', ({ assert }) => {
    const payload = toReplayablePayload({
      id: 'evt_3',
      createdAt: 9,
      provider: 'stripe',
      nativeType: 'customer.deleted',
      type: 'customer.deleted',
      data: { providerCustomerId: 'cus_del' },
    }) as any
    assert.equal(payload.data.providerCustomerId, 'cus_del')
  })
})

test.group('rebuildBillingEvent — checked cast', () => {
  test('round-trips a replayable subscription so plan resolution stays faithful', ({ assert }) => {
    const rebuilt = rebuildBillingEvent(toReplayablePayload(subEvent()))
    assert.isNotNull(rebuilt)
    assert.equal(rebuilt!.type, 'subscription.upsert')
    assert.equal((rebuilt!.data as any).productId, 'prod_pro')
  })

  test('returns null for nullish / malformed input', ({ assert }) => {
    assert.isNull(rebuildBillingEvent(null))
    assert.isNull(rebuildBillingEvent(undefined))
    assert.isNull(rebuildBillingEvent('nope'))
    assert.isNull(rebuildBillingEvent({ id: 'x', type: 'y' }))
  })
})
