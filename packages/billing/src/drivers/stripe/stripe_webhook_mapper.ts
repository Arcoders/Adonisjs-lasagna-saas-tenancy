import type Stripe from 'stripe'
import type { BillingWebhookEvent } from '../../contracts/types.js'
import { mapEventType, toInvoice, toSubscription } from './stripe_mapper.js'

/**
 * Convert a verified `Stripe.Event` into a neutral `BillingWebhookEvent`.
 * Native types the package doesn't handle become `{ type: 'unknown' }` so the
 * dispatcher no-ops them without dead-lettering.
 */
export function toBillingWebhookEvent(event: Stripe.Event): BillingWebhookEvent {
  const base = {
    id: event.id,
    createdAt: event.created,
    provider: 'stripe' as const,
    nativeType: event.type,
  }
  const type = mapEventType(event.type)

  switch (type) {
    case 'checkout.completed': {
      const session = event.data.object as Stripe.Checkout.Session
      const customerId =
        typeof session.customer === 'string' ? session.customer : (session.customer?.id ?? null)
      return {
        ...base,
        type,
        data: {
          customerId,
          clientReferenceId: session.client_reference_id ?? null,
          mode: session.mode ?? null,
        },
      }
    }
    case 'subscription.upsert':
    case 'subscription.deleted':
    case 'subscription.trial_will_end': {
      const sub = event.data.object as Stripe.Subscription
      return { ...base, type, data: toSubscription(sub) }
    }
    case 'payment.succeeded':
    case 'payment.failed': {
      const invoice = event.data.object as Stripe.Invoice
      return { ...base, type, data: toInvoice(invoice) }
    }
    case 'customer.deleted': {
      const customer = event.data.object as Stripe.Customer
      return { ...base, type, data: { providerCustomerId: customer.id } }
    }
    default:
      return { ...base, type: 'unknown', data: event.data.object }
  }
}
