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

/** Paddle Billing subscription status → neutral status. */
function mapStatus(status: string): SubscriptionStatus {
  switch (status) {
    case 'active':
      return 'active'
    case 'trialing':
      return 'trialing'
    case 'past_due':
      return 'past_due'
    case 'paused':
      return 'paused'
    case 'canceled':
    case 'cancelled':
      return 'canceled'
    default:
      return 'active'
  }
}

/** Paddle event name → canonical taxonomy. */
export function mapEventType(name: string): BillingEventType {
  switch (name) {
    case 'subscription.created':
    case 'subscription.updated':
    case 'subscription.activated':
    case 'subscription.paused':
    case 'subscription.resumed':
    case 'subscription.trialing':
      return 'subscription.upsert'
    case 'subscription.canceled':
    case 'subscription.cancelled':
      return 'subscription.deleted'
    case 'transaction.completed':
    case 'transaction.paid':
      return 'payment.succeeded'
    case 'transaction.payment_failed':
      return 'payment.failed'
    default:
      return 'unknown'
  }
}

interface PaddleSubscriptionData {
  id: string
  customer_id: string
  status: string
  current_billing_period?: { starts_at?: string; ends_at?: string } | null
  scheduled_change?: { action?: string; effective_at?: string } | null
  canceled_at?: string | null
  trial_dates?: { ends_at?: string } | null
  items?: Array<{ price?: { id?: string; product_id?: string } }>
  custom_data?: Record<string, unknown> | null
}

export function toSubscription(data: PaddleSubscriptionData): Subscription {
  const item = data.items?.[0]
  const period = data.current_billing_period
  const scheduledCancel =
    data.scheduled_change?.action === 'cancel' ? data.scheduled_change?.effective_at : null
  const now = Math.floor(Date.now() / 1000)
  return {
    providerSubscriptionId: data.id,
    customerId: data.customer_id,
    status: mapStatus(data.status),
    currentPeriodStart: isoToSeconds(period?.starts_at) ?? now,
    currentPeriodEnd: isoToSeconds(period?.ends_at) ?? now,
    cancelAtPeriodEnd: Boolean(scheduledCancel),
    cancelAt: isoToSeconds(scheduledCancel),
    canceledAt: isoToSeconds(data.canceled_at),
    trialEnd: isoToSeconds(data.trial_dates?.ends_at),
    productId: item?.price?.product_id ?? null,
    priceId: item?.price?.id ?? null,
    raw: data as unknown as Record<string, unknown>,
  }
}

interface PaddleTransactionData {
  id: string
  customer_id?: string | null
  subscription_id?: string | null
  currency_code?: string | null
  details?: { totals?: { grand_total?: string; balance?: string } } | null
  payments?: Array<{ status?: string }>
}

export function toInvoice(data: PaddleTransactionData): Invoice {
  // Paddle amounts are integer minor-unit strings (e.g. "1000" = 10.00).
  const grand = Number.parseInt(data.details?.totals?.grand_total ?? '0', 10) || 0
  return {
    id: data.id,
    customerId: data.customer_id ?? null,
    subscriptionId: data.subscription_id ?? null,
    amountPaid: grand,
    amountDue: grand,
    currency: (data.currency_code ?? 'usd').toLowerCase(),
    attemptCount: data.payments?.length ?? 0,
    nextPaymentAttempt: null,
  }
}

/**
 * Map a parsed Paddle webhook body to a neutral event. Paddle wraps the entity
 * in `{ event_id, event_type, occurred_at, data }`.
 */
export function toBillingWebhookEvent(body: {
  event_id?: string
  event_type?: string
  occurred_at?: string
  data?: unknown
}): BillingWebhookEvent {
  const nativeType = body.event_type ?? ''
  const base = {
    id: body.event_id ?? '',
    createdAt: isoToSeconds(body.occurred_at) ?? Math.floor(Date.now() / 1000),
    provider: 'paddle' as const,
    nativeType,
  }
  const type = mapEventType(nativeType)
  switch (type) {
    case 'subscription.upsert':
    case 'subscription.deleted':
      return { ...base, type, data: toSubscription(body.data as PaddleSubscriptionData) }
    case 'payment.succeeded':
    case 'payment.failed':
      return { ...base, type, data: toInvoice(body.data as PaddleTransactionData) }
    default:
      return { ...base, type: 'unknown', data: body.data }
  }
}
