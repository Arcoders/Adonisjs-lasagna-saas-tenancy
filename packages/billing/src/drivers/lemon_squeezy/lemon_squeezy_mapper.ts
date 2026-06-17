import type {
  BillingEventType,
  BillingWebhookEvent,
  Invoice,
  Subscription,
  SubscriptionStatus,
} from '../../contracts/types.js'

/** ISO-8601 string → epoch seconds, or null. */
export function isoToSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

/**
 * Lemon Squeezy subscription status → neutral status. `recognized: false` flags
 * a status string LS added that we don't map yet — the default is the
 * fail-closed `incomplete` (no entitlement) and `syncSubscription` keeps an
 * existing row's known status rather than trusting the guess.
 */
function mapStatus(status: string): { status: SubscriptionStatus; recognized: boolean } {
  switch (status) {
    case 'on_trial':
      return { status: 'trialing', recognized: true }
    case 'active':
      return { status: 'active', recognized: true }
    case 'past_due':
      return { status: 'past_due', recognized: true }
    case 'unpaid':
      return { status: 'unpaid', recognized: true }
    case 'paused':
      return { status: 'paused', recognized: true }
    case 'cancelled':
    case 'expired':
      return { status: 'canceled', recognized: true }
    default:
      return { status: 'incomplete', recognized: false }
  }
}

/** Lemon Squeezy `meta.event_name` → canonical taxonomy. */
export function mapEventType(name: string): BillingEventType {
  switch (name) {
    case 'subscription_created':
    case 'subscription_updated':
    case 'subscription_resumed':
    case 'subscription_unpaused':
    case 'subscription_paused':
      return 'subscription.upsert'
    case 'subscription_cancelled':
    case 'subscription_expired':
      return 'subscription.deleted'
    case 'subscription_payment_success':
    case 'subscription_payment_recovered':
      return 'payment.succeeded'
    case 'subscription_payment_failed':
      return 'payment.failed'
    default:
      return 'unknown'
  }
}

interface LsResource {
  id?: string | number
  attributes?: Record<string, unknown>
}

function attr<T>(data: LsResource | undefined, key: string): T | undefined {
  return data?.attributes?.[key] as T | undefined
}

export function toSubscription(data: LsResource | undefined): Subscription {
  const now = Math.floor(Date.now() / 1000)
  const cancelled = attr<boolean>(data, 'cancelled') ?? false
  const endsAt = attr<string>(data, 'ends_at') ?? null
  const mappedStatus = mapStatus(attr<string>(data, 'status') ?? '')
  return {
    providerSubscriptionId: String(data?.id ?? ''),
    customerId: String(attr<number | string>(data, 'customer_id') ?? ''),
    status: mappedStatus.status,
    statusRecognized: mappedStatus.recognized,
    currentPeriodStart: isoToSeconds(attr<string>(data, 'created_at')) ?? now,
    currentPeriodEnd: isoToSeconds(attr<string>(data, 'renews_at')) ?? now,
    cancelAtPeriodEnd: cancelled,
    cancelAt: isoToSeconds(endsAt),
    canceledAt: cancelled ? (isoToSeconds(attr<string>(data, 'updated_at')) ?? now) : null,
    trialEnd: isoToSeconds(attr<string>(data, 'trial_ends_at')),
    productId: String(attr<number | string>(data, 'product_id') ?? '') || null,
    priceId: String(attr<number | string>(data, 'variant_id') ?? '') || null,
    raw: (data ?? {}) as unknown as Record<string, unknown>,
  }
}

export function toInvoice(data: LsResource | undefined): Invoice {
  const total = Number(attr<number>(data, 'total') ?? 0) || 0
  return {
    id: String(data?.id ?? '') || null,
    customerId: String(attr<number | string>(data, 'customer_id') ?? '') || null,
    subscriptionId: String(attr<number | string>(data, 'subscription_id') ?? '') || null,
    amountPaid: total,
    amountDue: total,
    currency: (attr<string>(data, 'currency') ?? 'usd').toLowerCase(),
    // Lemon Squeezy webhooks carry no dunning attempt count. Report 0 ("none
    // from the provider") and let the dispatcher's provider-independent counter
    // drive escalation — see `handlePaymentFailed`.
    attemptCount: 0,
    nextPaymentAttempt: null,
  }
}

/**
 * Map a parsed Lemon Squeezy webhook body to a neutral event. LS bodies carry
 * no stable event id, so the driver passes a deterministic one synthesised from
 * the raw body hash (stable across LS retries of the same delivery).
 */
export function toBillingWebhookEvent(
  body: { meta?: { event_name?: string }; data?: LsResource },
  eventId: string
): BillingWebhookEvent {
  const nativeType = body.meta?.event_name ?? ''
  const data = body.data
  const base = {
    id: eventId,
    createdAt: isoToSeconds(attr<string>(data, 'created_at')) ?? Math.floor(Date.now() / 1000),
    provider: 'lemonsqueezy' as const,
    nativeType,
  }
  const type = mapEventType(nativeType)
  switch (type) {
    case 'subscription.upsert':
    case 'subscription.deleted':
      return { ...base, type, data: toSubscription(data) }
    case 'payment.succeeded':
    case 'payment.failed':
      return { ...base, type, data: toInvoice(data) }
    default:
      return { ...base, type: 'unknown', data }
  }
}
