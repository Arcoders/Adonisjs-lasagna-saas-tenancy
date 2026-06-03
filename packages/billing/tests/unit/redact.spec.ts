import { test } from '@japa/runner'
import {
  redactStripeEvent,
  REDACTED_EVENT_KEYS,
} from '../../src/services/billing/redact.js'
import type Stripe from 'stripe'

const SAFE_KEYS = new Set<string>(REDACTED_EVENT_KEYS)

const FORBIDDEN_KEYS = [
  'email',
  'name',
  'phone',
  'last4',
  'address',
  'shipping',
  'description',
  'statement_descriptor',
  'billing_details',
  'metadata',
] as const

function event(type: string, obj: Record<string, unknown>): Stripe.Event {
  return {
    id: 'evt_test_1',
    type,
    created: 1_700_000_000,
    api_version: '2025-08-27.basil',
    data: { object: obj },
  } as unknown as Stripe.Event
}

test.group('redactStripeEvent — strip-list semantics', () => {
  test('returns a fixed shape with only safe fields', ({ assert }) => {
    const e = event('customer.subscription.created', {
      id: 'sub_xx',
      customer: 'cus_xx',
      status: 'active',
      // Hostile fields below — must NEVER appear in the output.
      email: 'user@example.com',
      metadata: { credit_card: '4242', secret_token: 'shhh' },
      payment_method: { card: { last4: '4242', brand: 'visa' } },
    })
    const safe = redactStripeEvent(e)

    assert.equal(safe.id, 'evt_test_1')
    assert.equal(safe.type, 'customer.subscription.created')
    assert.equal(safe.subscription_id, 'sub_xx')
    assert.equal(safe.customer_id, 'cus_xx')
    assert.equal(safe.status, 'active')

    // The strip-list MUST NOT carry any field outside the documented shape.
    const json = JSON.stringify(safe)
    for (const key of FORBIDDEN_KEYS) {
      assert.notInclude(json, key, `redacted output leaked "${key}"`)
    }
    assert.notInclude(json, 'user@example.com')
    assert.notInclude(json, '4242')
    assert.notInclude(json, 'shhh')
  })

  test('extracts customer id from the customer object form', ({ assert }) => {
    const e = event('customer.subscription.updated', {
      id: 'sub_yy',
      customer: { id: 'cus_yy', email: 'should-not-leak@example.com' },
    })
    const safe = redactStripeEvent(e)
    assert.equal(safe.customer_id, 'cus_yy')
    assert.notInclude(JSON.stringify(safe), 'should-not-leak@example.com')
  })

  test('captures invoice fields without leaking PII', ({ assert }) => {
    const e = event('invoice.payment_failed', {
      id: 'in_zz',
      customer: 'cus_zz',
      amount_due: 1234,
      currency: 'eur',
      attempt_count: 2,
      status: 'open',
      // PII landmines:
      customer_name: 'Jane Doe',
      customer_email: 'jane@example.com',
      receipt_number: 'shhh',
    })
    const safe = redactStripeEvent(e)
    assert.equal(safe.invoice_id, 'in_zz')
    assert.equal(safe.customer_id, 'cus_zz')
    assert.equal(safe.amount, 1234)
    assert.equal(safe.currency, 'eur')
    assert.equal(safe.attempt_count, 2)
    assert.equal(safe.status, 'open')
    const json = JSON.stringify(safe)
    assert.notInclude(json, 'Jane Doe')
    assert.notInclude(json, 'jane@example.com')
    assert.notInclude(json, 'shhh')
  })

  test('handles minimal events without throwing', ({ assert }) => {
    const e = { id: 'evt_min', type: 'unknown.event', created: 1, data: {} } as unknown as Stripe.Event
    const safe = redactStripeEvent(e)
    assert.equal(safe.id, 'evt_min')
    assert.equal(safe.type, 'unknown.event')
    assert.isUndefined(safe.customer_id)
    assert.isUndefined(safe.subscription_id)
  })

  test('prefers id-prefix when extracting subscription/invoice ids', ({ assert }) => {
    // For sub.* events, `obj.id` is the subscription itself.
    const subEvent = event('customer.subscription.created', { id: 'sub_zzz', customer: 'cus_zzz' })
    assert.equal(redactStripeEvent(subEvent).subscription_id, 'sub_zzz')

    // For invoice events, `obj.id` is the invoice.
    const invEvent = event('invoice.payment_succeeded', { id: 'in_zzz', customer: 'cus_zzz' })
    assert.equal(redactStripeEvent(invEvent).invoice_id, 'in_zzz')
  })

  test('future-proof: every key on the output is in REDACTED_EVENT_KEYS', ({ assert }) => {
    // A regression that copies the raw object into the result (e.g. via a
    // `...obj` spread someone introduces in a refactor) would surface here:
    // an unknown key in the output means a strip-list violation.
    const cases = [
      event('customer.subscription.created', {
        id: 'sub_a',
        customer: 'cus_a',
        status: 'active',
        items: { data: [{ price: { id: 'price_x' } }] },
        metadata: { junk: 'value' },
      }),
      event('invoice.payment_failed', {
        id: 'in_a',
        customer: { id: 'cus_b', email: 'leak@example.com' },
        amount_due: 500,
        currency: 'eur',
        attempt_count: 2,
      }),
      event('checkout.session.completed', {
        id: 'cs_a',
        customer: 'cus_c',
        mode: 'subscription',
      }),
    ]
    for (const e of cases) {
      const safe = redactStripeEvent(e)
      for (const key of Object.keys(safe)) {
        assert.isTrue(SAFE_KEYS.has(key), `output key "${key}" not in REDACTED_EVENT_KEYS`)
      }
    }
  })
})
