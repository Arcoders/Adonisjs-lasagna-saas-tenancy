import type Stripe from 'stripe'

/**
 * Returns ONLY the safe-to-log fields of a Stripe event. Strip-list (not
 * mask-list) is intentional: a strip-list breaks loudly if Stripe adds a
 * new PII field, whereas a mask-list silently leaks it.
 *
 * Safe fields:
 *   - event id, type, created (timestamp), api_version
 *   - object id (sub_, in_, ...) — Stripe IDs are opaque, non-PII
 *   - customer id (cus_) — same
 *   - subscription id, invoice id when implicit on the event object
 *   - amount + currency on invoices (no card data)
 *   - dunning attempt_count
 *
 * NEVER include: email, name, phone, address, payment_method.card.last4,
 * customer.shipping, metadata (host-supplied — could contain anything),
 * description, statement_descriptor, raw billing_details.
 */
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
