import type { BillingEventType, BillingWebhookEvent } from '../../contracts/types.js'

/**
 * Redaction for the neutral billing event model.
 *
 * Neutral events are built by each driver's mapper from a named allowlist of
 * fields (ids, amounts, timestamps, status, period bounds) — they never carry
 * card data, emails, names, or addresses. The single PII vector is the
 * provider's `raw` payload preserved on subscription events, so
 * `toReplayablePayload` strips exactly that before the event is persisted to the
 * backoffice DB.
 */

/** Flat, log-safe projection of a neutral event. Used for structured logs. */
export interface RedactedBillingEvent {
  id: string
  type: BillingEventType
  provider: string
  native_type: string
  created: number
  customer_id?: string | undefined
  subscription_id?: string | undefined
  amount?: number
  currency?: string
  status?: string
}

export function redactBillingEvent(event: BillingWebhookEvent): RedactedBillingEvent {
  const out: RedactedBillingEvent = {
    id: event.id,
    type: event.type,
    provider: event.provider,
    native_type: event.nativeType,
    created: event.createdAt,
  }
  switch (event.type) {
    case 'subscription.upsert':
    case 'subscription.deleted':
    case 'subscription.trial_will_end':
      out.customer_id = event.data.customerId
      out.subscription_id = event.data.providerSubscriptionId
      out.status = event.data.status
      break
    case 'payment.succeeded':
      out.customer_id = event.data.customerId ?? undefined
      out.subscription_id = event.data.subscriptionId ?? undefined
      out.amount = event.data.amountPaid
      out.currency = event.data.currency
      break
    case 'payment.failed':
      out.customer_id = event.data.customerId ?? undefined
      out.subscription_id = event.data.subscriptionId ?? undefined
      out.amount = event.data.amountDue
      out.currency = event.data.currency
      break
    case 'checkout.completed':
      out.customer_id = event.data.customerId ?? undefined
      break
    case 'customer.deleted':
      out.customer_id = event.data.providerCustomerId
      break
  }
  return out
}

/**
 * Build the replayable payload persisted in `billing_processed_events.payload`,
 * so `BillingService.retrieveEvent()` can reconstruct the event when the
 * provider can no longer return it (aged out / a driver without event
 * retrieval). Strips the provider `raw` blob from subscription events — every
 * other neutral field is structural and safe.
 */
export function toReplayablePayload(event: BillingWebhookEvent): Record<string, unknown> {
  const base = {
    id: event.id,
    createdAt: event.createdAt,
    provider: event.provider,
    nativeType: event.nativeType,
    type: event.type,
  }
  if (
    event.type === 'subscription.upsert' ||
    event.type === 'subscription.deleted' ||
    event.type === 'subscription.trial_will_end'
  ) {
    const { raw: _raw, ...rest } = event.data
    return { ...base, data: { ...rest, raw: {} } }
  }
  return { ...base, data: event.data }
}

/**
 * Reconstruct a neutral `BillingWebhookEvent` from a persisted replayable
 * payload. Returns `null` for rows that can't be faithfully reconstructed
 * (missing id/type/data).
 */
export function rebuildBillingEvent(payload: unknown): BillingWebhookEvent | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Partial<BillingWebhookEvent>
  if (typeof p.id !== 'string' || typeof p.type !== 'string') return null
  if (!('data' in p)) return null
  return payload as BillingWebhookEvent
}
