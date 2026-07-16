import type Stripe from 'stripe'
import type {
  BillingEventType,
  Customer,
  Invoice,
  Subscription,
  SubscriptionStatus,
} from '../../contracts/types.js'
import { isKnownSubscriptionStatus } from '../../contracts/types.js'

/**
 * Stripe-to-neutral mappers. Every Stripe quirk that used to live in
 * `BillingService.syncSubscription` / the dispatcher is consolidated here, so
 * the rest of the package only ever sees neutral types.
 */

export function toCustomer(c: Stripe.Customer): Customer {
  return {
    providerCustomerId: c.id,
    currency: c.currency ?? null,
    defaultPaymentMethod: null,
    country: c.address?.country ?? null,
  }
}

export function toSubscription(sub: Stripe.Subscription): Subscription {
  const customerId = typeof sub.customer === 'string' ? sub.customer : (sub.customer?.id ?? '')
  const item = sub.items?.data?.[0]
  const productId =
    typeof item?.price?.product === 'string'
      ? item.price.product
      : (item?.price?.product?.id ?? null)
  const priceId = item?.price?.id ?? null

  // Stripe moved `current_period_{start,end}` from the top of Subscription onto
  // each `items.data[i]` in the 2025 API. Read the new location first; fall
  // back to the legacy top-level field via raw access for older API pinnings.
  const subItem = item as { current_period_start?: number; current_period_end?: number } | undefined
  const subRaw = sub as unknown as { current_period_start?: number; current_period_end?: number }
  const created = (sub as unknown as { created?: number }).created ?? 0
  const periodStart = subItem?.current_period_start ?? subRaw.current_period_start ?? created
  const periodEnd = subItem?.current_period_end ?? subRaw.current_period_end ?? created

  // Stripe's statuses match the neutral set 1:1, but guard against a future
  // status Stripe adds: fail closed to `incomplete` + flag it, rather than
  // writing a value the DB enum would reject (a hard crash) or silently
  // entitling the tenant.
  const statusRecognized = isKnownSubscriptionStatus(sub.status)

  return {
    providerSubscriptionId: sub.id,
    customerId,
    status: statusRecognized ? (sub.status as SubscriptionStatus) : 'incomplete',
    statusRecognized,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
    cancelAt: sub.cancel_at ?? null,
    canceledAt: sub.canceled_at ?? null,
    trialEnd: sub.trial_end ?? null,
    productId,
    priceId,
    raw: sub as unknown as Record<string, unknown>,
  }
}

/**
 * Stripe v18 nests the subscription reference under
 * `parent.subscription_details.subscription`. Older API pinnings expose it on
 * `invoice.subscription` directly. Read both shapes defensively.
 */
export function extractInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const invoiceRaw = invoice as unknown as {
    subscription?: string | { id?: string }
    parent?: { subscription_details?: { subscription?: string | { id?: string } } }
  }
  const ref = invoiceRaw.subscription ?? invoiceRaw.parent?.subscription_details?.subscription
  if (!ref) return null
  return typeof ref === 'string' ? ref : (ref.id ?? null)
}

export function toInvoice(invoice: Stripe.Invoice): Invoice {
  const customerId =
    typeof invoice.customer === 'string' ? invoice.customer : (invoice.customer?.id ?? null)
  return {
    id: invoice.id ?? null,
    customerId,
    subscriptionId: extractInvoiceSubscriptionId(invoice),
    amountPaid: invoice.amount_paid ?? 0,
    amountDue: invoice.amount_due ?? 0,
    currency: invoice.currency ?? 'usd',
    attemptCount: invoice.attempt_count ?? 0,
    nextPaymentAttempt: invoice.next_payment_attempt ?? null,
    subtotal: invoice.subtotal ?? null,
    // Stripe ≤ v17 exposes `tax`; v18+ moves the total tax to
    // `total_taxes[].amount`. Read the legacy field first, then sum the new one.
    tax: stripeInvoiceTax(invoice),
    total: invoice.total ?? null,
  }
}

/** Total tax from a Stripe invoice across API-version shapes (`tax` vs `total_taxes`). */
function stripeInvoiceTax(invoice: Stripe.Invoice): number | null {
  const raw = invoice as unknown as {
    tax?: number | null
    total_taxes?: Array<{ amount?: number }> | null
  }
  if (typeof raw.tax === 'number') return raw.tax
  if (Array.isArray(raw.total_taxes)) {
    return raw.total_taxes.reduce((sum, t) => sum + (t.amount ?? 0), 0)
  }
  return null
}

/** Map a Stripe event type onto the package's canonical taxonomy. */
export function mapEventType(stripeType: string): BillingEventType {
  switch (stripeType) {
    case 'checkout.session.completed':
      return 'checkout.completed'
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
      return 'subscription.upsert'
    case 'customer.subscription.deleted':
      return 'subscription.deleted'
    case 'customer.subscription.trial_will_end':
      return 'subscription.trial_will_end'
    case 'invoice.payment_succeeded':
      return 'payment.succeeded'
    case 'invoice.payment_failed':
      return 'payment.failed'
    case 'customer.deleted':
      return 'customer.deleted'
    default:
      return 'unknown'
  }
}
