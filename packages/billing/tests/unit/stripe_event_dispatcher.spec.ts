import { test } from '@japa/runner'
import {
  dispatchStripeEvent,
  extractInvoiceSubscriptionId,
} from '../../src/services/billing/stripe_event_dispatcher.js'
import type Stripe from 'stripe'

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as Parameters<typeof dispatchStripeEvent>[1]['logger']

function event(type: string, obj: Record<string, unknown> = {}): Stripe.Event {
  return {
    id: 'evt_disp_1',
    type,
    created: 1_700_000_000,
    api_version: '2025-08-27.basil',
    data: { object: obj },
  } as unknown as Stripe.Event
}

test.group('dispatchStripeEvent — routing', () => {
  test('unmapped event types resolve to a noop without touching billing/db', async ({ assert }) => {
    // No handler is registered for `charge.refunded`; the dispatcher must
    // short-circuit to noop (Stripe sends many types we do not care about,
    // and treating them as errors would noise up dead-letter alerts).
    const billingSpy = new Proxy(
      {},
      {
        get() {
          throw new Error('billing must not be touched for an unmapped event')
        },
      }
    ) as Parameters<typeof dispatchStripeEvent>[1]['billing']

    const result = await dispatchStripeEvent(event('charge.refunded'), {
      billing: billingSpy,
      logger: noopLogger,
    })
    assert.deepEqual(result, { outcome: 'noop' })
  })
})

test.group('extractInvoiceSubscriptionId — Stripe shape resilience', () => {
  test('reads the legacy top-level subscription field', ({ assert }) => {
    const invoice = { subscription: 'sub_legacy' } as unknown as Stripe.Invoice
    assert.equal(extractInvoiceSubscriptionId(invoice), 'sub_legacy')
  })

  test('reads the v18 nested parent.subscription_details.subscription', ({ assert }) => {
    const invoice = {
      parent: { subscription_details: { subscription: 'sub_nested' } },
    } as unknown as Stripe.Invoice
    assert.equal(extractInvoiceSubscriptionId(invoice), 'sub_nested')
  })

  test('reads an expanded subscription object form', ({ assert }) => {
    const invoice = { subscription: { id: 'sub_obj' } } as unknown as Stripe.Invoice
    assert.equal(extractInvoiceSubscriptionId(invoice), 'sub_obj')
  })

  test('returns null when no subscription reference is present (one-off invoice)', ({ assert }) => {
    const invoice = { id: 'in_oneoff' } as unknown as Stripe.Invoice
    assert.isNull(extractInvoiceSubscriptionId(invoice))
  })
})
