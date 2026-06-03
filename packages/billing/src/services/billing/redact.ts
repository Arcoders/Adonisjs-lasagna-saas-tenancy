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
  const subscriptionId = objId?.startsWith('sub_')
    ? objId
    : typeof obj.subscription === 'string'
      ? (obj.subscription as string)
      : undefined
  const invoiceId = objId?.startsWith('in_')
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

/*
 * Replayable payload.
 *
 * The webhook controller persists this into `stripe_processed_events.payload`
 * so `BillingService.retrieveEvent()` can reconstruct a faithful event when
 * Stripe can no longer return it, for instance after it aged out of the ~30-day
 * retrieval window during a late `tenant:billing:replay`.
 *
 * It uses the same allowlist discipline as `redactStripeEvent`: every field is
 * named explicitly and we never spread the raw object, so a new PII field that
 * Stripe introduces can never leak into the backoffice DB. Unlike the flat log
 * redactor it keeps the nested `data.object` shape the dispatcher handlers read,
 * but only with non-PII structural fields (opaque ids, amounts, timestamps,
 * status, period bounds).
 */

export interface ReplayableStripeEvent {
  id: string
  type: string
  created: number
  api_version: string | null
  data: { object: Record<string, unknown> }
}

/** Stripe expansions can surface a related field as a bare id or an object. */
function idOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') {
    return (v as { id: string }).id
  }
  return undefined
}

/**
 * Allowlist-build the non-PII subset of `event.data.object` that the
 * dispatcher handlers actually read, preserving the nested shape so the
 * reconstructed event flows through `dispatchStripeEvent` unchanged.
 *
 * The exact set of fields kept here is pinned by
 * `tests/unit/services/billing/replay_dispatcher_contract.spec.ts`. If a
 * handler starts reading a new field, that test fails until it's added below.
 */
function replayableObject(type: string, obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof obj.id === 'string') out.id = obj.id

  if (type.startsWith('customer.subscription.')) {
    const customer = idOf(obj.customer)
    if (customer) out.customer = customer
    if (typeof obj.status === 'string') out.status = obj.status
    if (typeof obj.cancel_at_period_end === 'boolean') {
      out.cancel_at_period_end = obj.cancel_at_period_end
    }
    if (typeof obj.cancel_at === 'number') out.cancel_at = obj.cancel_at
    if (typeof obj.canceled_at === 'number') out.canceled_at = obj.canceled_at
    if (typeof obj.trial_end === 'number') out.trial_end = obj.trial_end
    if (typeof obj.current_period_start === 'number')
      out.current_period_start = obj.current_period_start
    if (typeof obj.current_period_end === 'number') out.current_period_end = obj.current_period_end
    const items = (obj.items as { data?: unknown[] } | undefined)?.data
    if (Array.isArray(items)) {
      out.items = {
        data: items.map((raw) => {
          const item = (raw ?? {}) as Record<string, unknown>
          const red: Record<string, unknown> = {}
          const price = item.price as Record<string, unknown> | undefined
          if (price) {
            const p: Record<string, unknown> = {}
            if (typeof price.id === 'string') p.id = price.id
            const product = idOf(price.product)
            if (product) p.product = product
            red.price = p
          }
          if (typeof item.current_period_start === 'number') {
            red.current_period_start = item.current_period_start
          }
          if (typeof item.current_period_end === 'number') {
            red.current_period_end = item.current_period_end
          }
          return red
        }),
      }
    }
  } else if (type.startsWith('invoice.')) {
    const customer = idOf(obj.customer)
    if (customer) out.customer = customer
    if (typeof obj.status === 'string') out.status = obj.status
    if (typeof obj.currency === 'string') out.currency = obj.currency
    if (typeof obj.attempt_count === 'number') out.attempt_count = obj.attempt_count
    if (typeof obj.amount_paid === 'number') out.amount_paid = obj.amount_paid
    if (typeof obj.amount_due === 'number') out.amount_due = obj.amount_due
    if (typeof obj.next_payment_attempt === 'number') {
      out.next_payment_attempt = obj.next_payment_attempt
    }
    const parent = obj.parent as { subscription_details?: { subscription?: unknown } } | undefined
    const sub = idOf(obj.subscription) ?? idOf(parent?.subscription_details?.subscription)
    if (sub) out.subscription = sub
  } else if (type === 'checkout.session.completed') {
    const customer = idOf(obj.customer)
    if (customer) out.customer = customer
    if (typeof obj.mode === 'string') out.mode = obj.mode
    if (typeof obj.client_reference_id === 'string') {
      out.client_reference_id = obj.client_reference_id
    }
  }
  // customer.deleted (+ any unmapped type): only the opaque object id, set above.

  return out
}

export function toReplayablePayload(event: Stripe.Event): ReplayableStripeEvent {
  const obj = (event.data?.object ?? {}) as unknown as Record<string, unknown>
  return {
    id: event.id,
    type: event.type,
    created: event.created,
    api_version: event.api_version ?? null,
    data: { object: replayableObject(event.type, obj) },
  }
}

/**
 * Reconstruct a `Stripe.Event` from a persisted replayable payload. The
 * payload already carries the faithful nested shape, so this is a checked
 * cast: returns `null` for legacy rows that stored the flat log-redaction
 * summary (no `data.object`), which cannot be faithfully reconstructed.
 */
export function rebuildStripeEvent(payload: unknown): Stripe.Event | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Partial<ReplayableStripeEvent>
  if (typeof p.id !== 'string' || typeof p.type !== 'string') return null
  const dataObject = (p.data as { object?: unknown } | undefined)?.object
  if (!dataObject || typeof dataObject !== 'object') return null
  return payload as unknown as Stripe.Event
}
