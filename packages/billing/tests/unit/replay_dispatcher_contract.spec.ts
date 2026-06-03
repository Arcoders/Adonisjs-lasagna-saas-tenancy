import { test } from '@japa/runner'
import type Stripe from 'stripe'
import { toReplayablePayload, rebuildStripeEvent } from '../../src/services/billing/redact.js'
import { extractInvoiceSubscriptionId } from '../../src/services/billing/stripe_event_dispatcher.js'

/**
 * Contract guard between the dispatcher and the replay allowlist.
 *
 * `toReplayablePayload` keeps only an allowlisted subset of each Stripe event.
 * If a dispatcher handler reads a field that the allowlist drops, a replayed
 * event (rebuilt from `stripe_processed_events.payload`) silently loses it, and
 * a late `tenant:billing:replay` mis-handles the event.
 *
 * Each projection below mirrors exactly the fields a handler reads in
 * `stripe_event_dispatcher.ts` and `BillingService.syncSubscription`. The test
 * round-trips a full event through replay and asserts the projection is
 * identical. When you teach a handler to read a new field, add it to the
 * matching projection here. The test then fails until the allowlist in
 * `redact.ts` preserves that field.
 */

const EVENT_CREATED = 1_700_000_000

function roundTrip(evt: Stripe.Event): Stripe.Event {
  const rebuilt = rebuildStripeEvent(toReplayablePayload(evt))
  if (!rebuilt) throw new Error('round-trip produced a null event')
  return rebuilt
}

function event(type: string, obj: Record<string, unknown>): Stripe.Event {
  return {
    id: 'evt_contract',
    type,
    created: EVENT_CREATED,
    api_version: '2025-08-27.basil',
    data: { object: obj },
  } as unknown as Stripe.Event
}

// PII that must never survive the allowlist, embedded across the fixtures.
const PII_NEEDLES = [
  'jane@example.com',
  'Jane Doe',
  '+1-555-0100',
  'TOP-SECRET',
  '4242',
  'receipt-shhh',
  'metadata',
  'billing_details',
  'payment_method',
]

function assertNoPii(assert: any, e: Stripe.Event): void {
  const json = JSON.stringify(toReplayablePayload(e))
  for (const needle of PII_NEEDLES) {
    assert.notInclude(json, needle, `replay payload leaked "${needle}"`)
  }
}

// Mirrors BillingService.syncSubscription's field reads.
function subscriptionProjection(sub: any) {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id
  const item = sub.items?.data?.[0]
  const productId =
    typeof item?.price?.product === 'string' ? item.price.product : item?.price?.product?.id
  const priceId = item?.price?.id
  const periodStart = item?.current_period_start ?? sub.current_period_start ?? EVENT_CREATED
  const periodEnd = item?.current_period_end ?? sub.current_period_end ?? EVENT_CREATED
  return {
    customerId,
    productId,
    priceId,
    status: sub.status,
    periodStart,
    periodEnd,
    cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
    cancelAt: sub.cancel_at ?? null,
    canceledAt: sub.canceled_at ?? null,
    trialEnd: sub.trial_end ?? null,
  }
}

// Mirrors handlePaymentSucceeded / handlePaymentFailed field reads.
function invoiceProjection(inv: any) {
  const customerId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id
  return {
    id: inv.id ?? null,
    customerId,
    subscriptionId: extractInvoiceSubscriptionId(inv as Stripe.Invoice),
    amountPaid: inv.amount_paid ?? 0,
    amountDue: inv.amount_due ?? 0,
    currency: inv.currency ?? 'usd',
    attemptCount: inv.attempt_count ?? 0,
    nextPaymentAttempt: inv.next_payment_attempt ?? null,
  }
}

test.group('replay/dispatcher contract', () => {
  test('subscription (2025 item-level periods, expanded refs): every read field survives', ({
    assert,
  }) => {
    const obj = {
      id: 'sub_c',
      object: 'subscription',
      customer: { id: 'cus_c', email: 'jane@example.com' },
      status: 'active',
      cancel_at_period_end: true,
      cancel_at: 1_700_900_000,
      canceled_at: null,
      trial_end: 1_700_300_000,
      items: {
        object: 'list',
        data: [
          {
            price: { id: 'price_pro', product: { id: 'prod_pro', name: 'Pro (do not leak)' } },
            current_period_start: 1_700_000_000,
            current_period_end: 1_702_592_000,
          },
        ],
      },
      metadata: { internal: 'TOP-SECRET' },
      billing_details: { email: 'jane@example.com', name: 'Jane Doe', phone: '+1-555-0100' },
      payment_method: { card: { last4: '4242' } },
    }
    const e = event('customer.subscription.updated', obj)
    assert.deepEqual(subscriptionProjection(roundTrip(e).data.object), subscriptionProjection(obj))
    assertNoPii(assert, e)
  })

  test('subscription (legacy top-level periods): period bounds survive replay', ({ assert }) => {
    const obj = {
      id: 'sub_legacy',
      customer: 'cus_legacy',
      status: 'active',
      // Older API pinning puts period bounds at the top level, not on items.
      current_period_start: 1_699_000_000,
      current_period_end: 1_701_592_000,
      items: { data: [{ price: { id: 'price_basic', product: 'prod_basic' } }] },
    }
    const e = event('customer.subscription.updated', obj)
    const proj = subscriptionProjection(roundTrip(e).data.object)
    assert.equal(proj.periodStart, 1_699_000_000)
    assert.equal(proj.periodEnd, 1_701_592_000)
    assert.deepEqual(proj, subscriptionProjection(obj))
  })

  test('invoice (Stripe v18 nested subscription): every read field survives', ({ assert }) => {
    const obj = {
      id: 'in_c',
      customer: 'cus_inv',
      status: 'open',
      currency: 'eur',
      attempt_count: 2,
      amount_due: 4200,
      amount_paid: 0,
      next_payment_attempt: 1_700_900_000,
      parent: { subscription_details: { subscription: 'sub_inv' } },
      receipt_number: 'receipt-shhh',
      customer_email: 'jane@example.com',
    }
    const e = event('invoice.payment_failed', obj)
    assert.deepEqual(invoiceProjection(roundTrip(e).data.object), invoiceProjection(obj))
    assertNoPii(assert, e)
  })

  test('invoice (legacy top-level subscription string): subscription ref survives', ({ assert }) => {
    const obj = {
      id: 'in_legacy',
      customer: { id: 'cus_inv2', email: 'jane@example.com' },
      currency: 'usd',
      amount_paid: 999,
      subscription: 'sub_top',
    }
    const e = event('invoice.payment_succeeded', obj)
    const proj = invoiceProjection(roundTrip(e).data.object)
    assert.equal(proj.subscriptionId, 'sub_top')
    assert.deepEqual(proj, invoiceProjection(obj))
  })

  test('checkout.session.completed: mode + client_reference_id + customer survive', ({ assert }) => {
    const obj = {
      id: 'cs_c',
      mode: 'subscription',
      client_reference_id: 'tenant-uuid',
      customer: 'cus_co',
      customer_details: { email: 'jane@example.com', name: 'Jane Doe' },
    }
    const e = event('checkout.session.completed', obj)
    const out = roundTrip(e).data.object as any
    assert.equal(out.mode, 'subscription')
    assert.equal(out.client_reference_id, 'tenant-uuid')
    assert.equal(typeof out.customer === 'string' ? out.customer : out.customer?.id, 'cus_co')
    assertNoPii(assert, e)
  })

  test('customer.subscription.trial_will_end: customer + trial_end + id survive', ({ assert }) => {
    const obj = {
      id: 'sub_trial',
      customer: 'cus_trial',
      status: 'trialing',
      trial_end: 1_700_300_000,
      billing_details: { email: 'jane@example.com' },
    }
    const e = event('customer.subscription.trial_will_end', obj)
    const out = roundTrip(e).data.object as any
    assert.equal(out.id, 'sub_trial')
    assert.equal(typeof out.customer === 'string' ? out.customer : out.customer?.id, 'cus_trial')
    assert.equal(out.trial_end, 1_700_300_000)
  })

  test('customer.deleted: only the opaque id survives', ({ assert }) => {
    const obj = { id: 'cus_del', email: 'jane@example.com', name: 'Jane Doe' }
    const e = event('customer.deleted', obj)
    const out = roundTrip(e).data.object as any
    assert.equal(out.id, 'cus_del')
    assert.notProperty(out, 'email')
    assert.notProperty(out, 'name')
  })
})
