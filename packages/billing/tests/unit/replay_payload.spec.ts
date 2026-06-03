import { test } from '@japa/runner'
import { toReplayablePayload, rebuildStripeEvent } from '../../src/services/billing/redact.js'
import type Stripe from 'stripe'

function event(type: string, obj: Record<string, unknown>): Stripe.Event {
  return {
    id: 'evt_replay_1',
    type,
    created: 1_700_000_000,
    api_version: '2025-08-27.basil',
    data: { object: obj },
  } as unknown as Stripe.Event
}

/**
 * A subscription object shaped like a real Stripe 2025-API event payload
 * (period bounds live on `items.data[i]`), spiked with every PII landmine.
 */
function subscriptionObject(): Record<string, unknown> {
  return {
    id: 'sub_abc',
    object: 'subscription',
    customer: 'cus_abc',
    status: 'active',
    cancel_at_period_end: true,
    cancel_at: 1_700_500_000,
    canceled_at: null,
    trial_end: 1_700_300_000,
    items: {
      object: 'list',
      data: [
        {
          price: { id: 'price_pro_monthly', product: 'prod_pro' },
          current_period_start: 1_700_000_000,
          current_period_end: 1_702_592_000,
        },
      ],
    },
    // PII landmines — must NEVER survive redaction.
    metadata: { internal_secret: 'TOP-SECRET' },
    billing_details: { email: 'user@example.com', name: 'Jane Doe', phone: '+1-555' },
    payment_method: { card: { last4: '4242', brand: 'visa' } },
  }
}

const PII_NEEDLES = [
  'TOP-SECRET',
  'user@example.com',
  'Jane Doe',
  '+1-555',
  '4242',
  'metadata',
  'billing_details',
  'payment_method',
]

test.group('toReplayablePayload — faithful, PII-free', () => {
  test('keeps the structural subscription fields the dispatcher reads', ({ assert }) => {
    const payload = toReplayablePayload(
      event('customer.subscription.updated', subscriptionObject())
    )

    assert.equal(payload.id, 'evt_replay_1')
    assert.equal(payload.type, 'customer.subscription.updated')
    assert.equal(payload.created, 1_700_000_000)

    const obj = payload.data.object as any
    assert.equal(obj.id, 'sub_abc')
    assert.equal(obj.customer, 'cus_abc')
    assert.equal(obj.status, 'active')
    assert.equal(obj.cancel_at_period_end, true)
    assert.equal(obj.cancel_at, 1_700_500_000)
    assert.equal(obj.trial_end, 1_700_300_000)
    assert.equal(obj.items.data[0].price.id, 'price_pro_monthly')
    assert.equal(obj.items.data[0].price.product, 'prod_pro')
    assert.equal(obj.items.data[0].current_period_start, 1_700_000_000)
    assert.equal(obj.items.data[0].current_period_end, 1_702_592_000)
  })

  test('leaks no PII regardless of hostile input', ({ assert }) => {
    const payload = toReplayablePayload(
      event('customer.subscription.updated', subscriptionObject())
    )
    const json = JSON.stringify(payload)
    for (const needle of PII_NEEDLES) {
      assert.notInclude(json, needle, `replayable payload leaked "${needle}"`)
    }
  })

  test('extracts customer/product when expanded as objects', ({ assert }) => {
    const obj = subscriptionObject()
    obj.customer = { id: 'cus_obj', email: 'leak@example.com' }
    ;(obj.items as any).data[0].price.product = { id: 'prod_obj', name: 'leaky' }
    const payload = toReplayablePayload(event('customer.subscription.created', obj))
    const out = payload.data.object as any
    assert.equal(out.customer, 'cus_obj')
    assert.equal(out.items.data[0].price.product, 'prod_obj')
    assert.notInclude(JSON.stringify(payload), 'leak@example.com')
    assert.notInclude(JSON.stringify(payload), 'leaky')
  })

  test('invoice: captures amounts, attempt_count and nested subscription ref', ({ assert }) => {
    const payload = toReplayablePayload(
      event('invoice.payment_failed', {
        id: 'in_xyz',
        customer: 'cus_xyz',
        status: 'open',
        currency: 'eur',
        attempt_count: 3,
        amount_due: 4200,
        amount_paid: 0,
        next_payment_attempt: 1_700_900_000,
        // Stripe v18 nests the subscription reference here.
        parent: { subscription_details: { subscription: 'sub_inv' } },
        receipt_number: 'shhh',
      })
    )
    const obj = payload.data.object as any
    assert.equal(obj.id, 'in_xyz')
    assert.equal(obj.customer, 'cus_xyz')
    assert.equal(obj.attempt_count, 3)
    assert.equal(obj.amount_due, 4200)
    assert.equal(obj.next_payment_attempt, 1_700_900_000)
    assert.equal(obj.subscription, 'sub_inv')
    assert.notInclude(JSON.stringify(payload), 'shhh')
  })

  test('checkout.session.completed: mode + client_reference_id + customer', ({ assert }) => {
    const payload = toReplayablePayload(
      event('checkout.session.completed', {
        id: 'cs_1',
        mode: 'subscription',
        client_reference_id: 'tenant-uuid',
        customer: 'cus_co',
        customer_details: { email: 'leak@example.com' },
      })
    )
    const obj = payload.data.object as any
    assert.equal(obj.mode, 'subscription')
    assert.equal(obj.client_reference_id, 'tenant-uuid')
    assert.equal(obj.customer, 'cus_co')
    assert.notInclude(JSON.stringify(payload), 'leak@example.com')
  })

  test('customer.deleted: only the opaque object id', ({ assert }) => {
    const payload = toReplayablePayload(
      event('customer.deleted', { id: 'cus_del', email: 'gone@example.com', name: 'Gone' })
    )
    const obj = payload.data.object as any
    assert.equal(obj.id, 'cus_del')
    assert.notProperty(obj, 'email')
    assert.notInclude(JSON.stringify(payload), 'gone@example.com')
  })
})

test.group('rebuildStripeEvent — checked cast', () => {
  test('round-trips a replayable subscription so plan resolution stays faithful', ({ assert }) => {
    const payload = toReplayablePayload(
      event('customer.subscription.updated', subscriptionObject())
    )
    const rebuilt = rebuildStripeEvent(payload)
    assert.isNotNull(rebuilt)
    const sub = rebuilt!.data.object as unknown as Stripe.Subscription
    // The fields `syncSubscription` reads for plan mapping must survive.
    assert.equal(sub.items.data[0].price.product as string, 'prod_pro')
    assert.equal(sub.items.data[0].price.id, 'price_pro_monthly')
    assert.equal(sub.status, 'active')
  })

  test('returns null for legacy flat payloads (no data.object)', ({ assert }) => {
    // The old log-redaction summary shape — cannot be reconstructed.
    const legacy = {
      id: 'evt_old',
      type: 'customer.subscription.updated',
      created: 1,
      customer_id: 'cus_x',
      subscription_id: 'sub_x',
    }
    assert.isNull(rebuildStripeEvent(legacy))
  })

  test('returns null for nullish / malformed input', ({ assert }) => {
    assert.isNull(rebuildStripeEvent(null))
    assert.isNull(rebuildStripeEvent(undefined))
    assert.isNull(rebuildStripeEvent('nope'))
    assert.isNull(rebuildStripeEvent({ id: 'x', type: 'y' }))
    assert.isNull(rebuildStripeEvent({ id: 'x', type: 'y', data: { object: null } }))
  })
})
