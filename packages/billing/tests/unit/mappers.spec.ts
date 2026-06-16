import { test } from '@japa/runner'
import type Stripe from 'stripe'
import { toBillingWebhookEvent as stripeMap } from '../../src/drivers/stripe/stripe_webhook_mapper.js'
import { toBillingWebhookEvent as paddleMap } from '../../src/drivers/paddle/paddle_mapper.js'
import { toBillingWebhookEvent as lsMap } from '../../src/drivers/lemon_squeezy/lemon_squeezy_mapper.js'

function stripeEvent(type: string, object: Record<string, unknown>): Stripe.Event {
  return {
    id: 'evt_1',
    type,
    created: 1_700_000_000,
    api_version: '2025-08-27.basil',
    data: { object },
  } as unknown as Stripe.Event
}

test.group('Stripe webhook mapper → neutral', () => {
  test('subscription: reads period bounds off items.data[0] and product/price', ({ assert }) => {
    const e = stripeMap(
      stripeEvent('customer.subscription.updated', {
        id: 'sub_a',
        customer: 'cus_a',
        status: 'active',
        cancel_at_period_end: true,
        items: {
          data: [
            {
              price: { id: 'price_pro', product: 'prod_pro' },
              current_period_start: 1_700_000_000,
              current_period_end: 1_702_592_000,
            },
          ],
        },
      })
    )
    assert.equal(e.type, 'subscription.upsert')
    assert.equal(e.provider, 'stripe')
    const sub = e.data as any
    assert.equal(sub.providerSubscriptionId, 'sub_a')
    assert.equal(sub.customerId, 'cus_a')
    assert.equal(sub.productId, 'prod_pro')
    assert.equal(sub.priceId, 'price_pro')
    assert.equal(sub.currentPeriodStart, 1_700_000_000)
    assert.equal(sub.currentPeriodEnd, 1_702_592_000)
    assert.isTrue(sub.cancelAtPeriodEnd)
  })

  test('invoice: resolves the v18 nested subscription ref + amounts', ({ assert }) => {
    const e = stripeMap(
      stripeEvent('invoice.payment_failed', {
        id: 'in_a',
        customer: 'cus_a',
        currency: 'eur',
        amount_due: 4200,
        attempt_count: 3,
        parent: { subscription_details: { subscription: 'sub_inv' } },
      })
    )
    assert.equal(e.type, 'payment.failed')
    const inv = e.data as any
    assert.equal(inv.subscriptionId, 'sub_inv')
    assert.equal(inv.amountDue, 4200)
    assert.equal(inv.currency, 'eur')
    assert.equal(inv.attemptCount, 3)
  })

  test('checkout + customer.deleted + unmapped', ({ assert }) => {
    const co = stripeMap(
      stripeEvent('checkout.session.completed', {
        id: 'cs_a',
        mode: 'subscription',
        client_reference_id: 'tenant-1',
        customer: 'cus_a',
      })
    )
    assert.equal(co.type, 'checkout.completed')
    assert.equal((co.data as any).clientReferenceId, 'tenant-1')
    assert.equal((co.data as any).mode, 'subscription')

    const del = stripeMap(stripeEvent('customer.deleted', { id: 'cus_x' }))
    assert.equal(del.type, 'customer.deleted')
    assert.equal((del.data as any).providerCustomerId, 'cus_x')

    const unknown = stripeMap(stripeEvent('charge.refunded', { id: 'ch_1' }))
    assert.equal(unknown.type, 'unknown')
  })
})

test.group('Paddle webhook mapper → neutral', () => {
  test('subscription.created → subscription.upsert with ISO periods converted', ({ assert }) => {
    const e = paddleMap({
      event_id: 'ntf_1',
      event_type: 'subscription.created',
      occurred_at: '2024-01-01T00:00:00Z',
      data: {
        id: 'sub_pdl',
        customer_id: 'ctm_1',
        status: 'trialing',
        current_billing_period: {
          starts_at: '2024-01-01T00:00:00Z',
          ends_at: '2024-02-01T00:00:00Z',
        },
        items: [{ price: { id: 'pri_1', product_id: 'pro_1' } }],
      },
    })
    assert.equal(e.type, 'subscription.upsert')
    assert.equal(e.provider, 'paddle')
    const sub = e.data as any
    assert.equal(sub.providerSubscriptionId, 'sub_pdl')
    assert.equal(sub.customerId, 'ctm_1')
    assert.equal(sub.status, 'trialing')
    assert.equal(sub.productId, 'pro_1')
    assert.equal(sub.priceId, 'pri_1')
    assert.equal(sub.currentPeriodStart, Math.floor(Date.parse('2024-01-01T00:00:00Z') / 1000))
  })

  test('transaction.completed → payment.succeeded', ({ assert }) => {
    const e = paddleMap({
      event_id: 'ntf_2',
      event_type: 'transaction.completed',
      occurred_at: '2024-01-01T00:00:00Z',
      data: {
        id: 'txn_1',
        customer_id: 'ctm_1',
        subscription_id: 'sub_pdl',
        currency_code: 'USD',
        details: { totals: { grand_total: '1000' } },
      },
    })
    assert.equal(e.type, 'payment.succeeded')
    const inv = e.data as any
    assert.equal(inv.subscriptionId, 'sub_pdl')
    assert.equal(inv.amountPaid, 1000)
    assert.equal(inv.currency, 'usd')
  })
})

test.group('Lemon Squeezy webhook mapper → neutral', () => {
  test('subscription_created → subscription.upsert with status + variant mapping', ({ assert }) => {
    const e = lsMap(
      {
        meta: { event_name: 'subscription_created' },
        data: {
          id: 42,
          attributes: {
            status: 'on_trial',
            customer_id: 7,
            product_id: 3,
            variant_id: 9,
            created_at: '2024-01-01T00:00:00Z',
            renews_at: '2024-02-01T00:00:00Z',
          },
        },
      },
      'lsq_evt_1'
    )
    assert.equal(e.type, 'subscription.upsert')
    assert.equal(e.provider, 'lemonsqueezy')
    assert.equal(e.id, 'lsq_evt_1')
    const sub = e.data as any
    assert.equal(sub.providerSubscriptionId, '42')
    assert.equal(sub.customerId, '7')
    assert.equal(sub.status, 'trialing')
    assert.equal(sub.productId, '3')
    assert.equal(sub.priceId, '9')
  })

  test('subscription_payment_failed → payment.failed', ({ assert }) => {
    const e = lsMap(
      {
        meta: { event_name: 'subscription_payment_failed' },
        data: {
          id: 100,
          attributes: { subscription_id: 42, customer_id: 7, total: 999, currency: 'USD' },
        },
      },
      'lsq_evt_2'
    )
    assert.equal(e.type, 'payment.failed')
    const inv = e.data as any
    assert.equal(inv.subscriptionId, '42')
    assert.equal(inv.amountDue, 999)
    assert.equal(inv.currency, 'usd')
  })
})
