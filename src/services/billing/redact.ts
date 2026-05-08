import type Stripe from 'stripe'

/**
 * OUTPUT IS A STRIP-LIST: only fields explicitly added below are returned.
 * Adding a field requires deliberate review against the PII matrix —
 * never copy `obj` into the result, never spread `event.data.object`,
 * never `Object.assign(result, obj)`. The shape is intentionally narrow
 * so that a future code path that logs `redactStripeEvent(event)` cannot
 * leak a new PII field that Stripe might introduce.
 *
 * Safe fields kept:
 *   - event id, type, created (timestamp), api_version
 *   - object id (sub_, in_, …) — Stripe IDs are opaque, non-PII
 *   - customer id (cus_)
 *   - subscription id, invoice id when implicit on the event object
 *   - amount + currency on invoices (no card data)
 *   - dunning attempt_count
 *   - top-level status string (subscription/invoice state)
 *
 * Fields with PII risk that MUST NEVER be added without review:
 *   email, name, phone, address, customer.shipping, billing_details,
 *   payment_method.card.last4, description, statement_descriptor,
 *   receipt_email, receipt_number, metadata (host-supplied; could be
 *   anything).
 */

/** Set of keys that may appear on the redacted output — used by tests. */
export const REDACTED_EVENT_KEYS = [
  'id',
  'type',
  'created',
  'api_version',
  'customer_id',
  'subscription_id',
  'invoice_id',
  'amount',
  'currency',
  'attempt_count',
  'status',
] as const

export interface RedactedStripeEvent {
  id: string
  type: string
  created: number
  api_version: string | null
  customer_id?: string
  subscription_id?: string
  invoice_id?: string
  amount?: number
  currency?: string
  attempt_count?: number
  status?: string
}

export function redactStripeEvent(event: Stripe.Event): RedactedStripeEvent {
  const obj = (event.data?.object ?? {}) as unknown as Record<string, unknown>

  const customerField = obj.customer
  const customerId =
    typeof customerField === 'string'
      ? customerField
      : (customerField as { id?: string } | null)?.id

  const objId = typeof obj.id === 'string' ? obj.id : undefined
  const subscriptionId =
    objId?.startsWith('sub_')
      ? objId
      : typeof obj.subscription === 'string'
        ? (obj.subscription as string)
        : undefined
  const invoiceId =
    objId?.startsWith('in_')
      ? objId
      : typeof obj.invoice === 'string'
        ? (obj.invoice as string)
        : undefined

  const result: RedactedStripeEvent = {
    id: event.id,
    type: event.type,
    created: event.created,
    api_version: event.api_version ?? null,
  }
  if (customerId) result.customer_id = customerId
  if (subscriptionId) result.subscription_id = subscriptionId
  if (invoiceId) result.invoice_id = invoiceId
  if (typeof obj.amount === 'number') result.amount = obj.amount
  if (typeof obj.amount_due === 'number') result.amount = obj.amount_due
  if (typeof obj.currency === 'string') result.currency = obj.currency
  if (typeof obj.attempt_count === 'number') result.attempt_count = obj.attempt_count
  if (typeof obj.status === 'string') result.status = obj.status

  return result
}
