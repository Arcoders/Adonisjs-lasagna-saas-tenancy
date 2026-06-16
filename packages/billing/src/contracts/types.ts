/**
 * Provider-agnostic billing data types.
 *
 * Every billing driver (Stripe, Paddle, Lemon Squeezy, ...) maps its native
 * SDK shapes onto these. The dispatcher and `BillingService` only ever see
 * neutral types — provider quirks live entirely inside each driver's mapper.
 *
 * Timestamps are epoch **seconds** (the unit Stripe uses natively and the unit
 * `BillingService`/the dispatcher already feed to `DateTime.fromSeconds`).
 * Drivers whose API returns ISO strings (Paddle, Lemon Squeezy) convert in
 * their mapper.
 */

/**
 * The shipped driver names, plus any custom name a host registers via
 * `BillingDriverRegistry.register()`. `(string & {})` keeps editor
 * autocomplete for the built-ins while admitting custom names — mirrors
 * `IsolationDriverName`.
 */
export type BillingDriverName = 'stripe' | 'paddle' | 'lemonsqueezy' | (string & {})

/**
 * Optional driver features. `BillingService` calls `driver.supports(cap)`
 * before invoking a capability-gated method and throws
 * `BillingException('unsupported_by_driver')` when the active driver lacks it,
 * rather than silently faking the operation.
 */
export type BillingCapability =
  | 'checkout'
  | 'billing_portal'
  | 'usage_metering'
  | 'event_retrieval'
  | 'price_lookup'
  | 'subscription_cancel'

/**
 * Neutral subscription status. Identical to the original
 * `StripeSubscriptionStatus` set — drivers map their native statuses onto it
 * (Paddle `active|trialing|past_due|paused|canceled`, Lemon Squeezy
 * `on_trial|active|past_due|unpaid|cancelled|expired`, ...).
 */
export type SubscriptionStatus =
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused'

/** Neutral customer, as returned by `ensureCustomer`. */
export interface Customer {
  /** The provider's customer id (e.g. Stripe `cus_…`). */
  providerCustomerId: string
  currency: string | null
  defaultPaymentMethod: string | null
}

/**
 * Neutral subscription. The mapper resolves provider quirks (e.g. Stripe's
 * 2025 move of `current_period_{start,end}` onto `items.data[i]`) so these
 * fields are always clean.
 */
export interface Subscription {
  providerSubscriptionId: string
  /** The provider customer id this subscription belongs to. */
  customerId: string
  status: SubscriptionStatus
  currentPeriodStart: number
  currentPeriodEnd: number
  cancelAtPeriodEnd: boolean
  cancelAt: number | null
  canceledAt: number | null
  trialEnd: number | null
  /** Product id used for plan resolution against `config.billing.products`. */
  productId: string | null
  /** Price id used for plan resolution against `config.billing.products`. */
  priceId: string | null
  /** Full native payload, persisted in `billing_subscriptions.raw`. */
  raw: Record<string, unknown>
}

/**
 * Neutral invoice / charge, used by the payment handlers. The mapper resolves
 * the subscription reference (e.g. Stripe v18 nests it under
 * `parent.subscription_details.subscription`).
 */
export interface Invoice {
  id: string | null
  customerId: string | null
  subscriptionId: string | null
  amountPaid: number
  amountDue: number
  currency: string
  /** Dunning attempt count for `payment.failed`. */
  attemptCount: number
  /** Epoch seconds of the next retry, when the provider schedules one. */
  nextPaymentAttempt: number | null
}

/** Data carried by a `checkout.completed` event. */
export interface CheckoutCompleted {
  /** The provider customer id created/used by checkout. */
  customerId: string | null
  /** Our tenant id, threaded through `client_reference_id`/custom data. */
  clientReferenceId: string | null
  mode: 'subscription' | 'payment' | string | null
}

/** Data carried by a `customer.deleted` event. */
export interface CustomerRef {
  providerCustomerId: string
}

/** Neutral price lookup result, used by the checkout price allowlist fallback. */
export interface Price {
  id: string
  productId: string | null
}

/**
 * The canonical event taxonomy. Drivers map every native webhook type onto one
 * of these (Stripe `customer.subscription.{created,updated,paused,resumed}` all
 * collapse to `subscription.upsert`). Native types we don't handle map to
 * `unknown` so the dispatcher no-ops without dead-lettering.
 */
export type BillingEventType =
  | 'checkout.completed'
  | 'subscription.upsert'
  | 'subscription.deleted'
  | 'subscription.trial_will_end'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'customer.deleted'
  | 'unknown'

interface BillingWebhookEventBase {
  /** Provider event id — the idempotency key for the processed-events ledger. */
  id: string
  /** Epoch seconds the provider stamped on the event. */
  createdAt: number
  /** The driver that produced this event. */
  provider: BillingDriverName
  /** The provider's native event type string, for logs/diagnostics. */
  nativeType: string
}

/**
 * A verified, provider-agnostic webhook event. Discriminated on `type` so the
 * dispatcher handlers get a precisely-typed `data` payload.
 */
export type BillingWebhookEvent = BillingWebhookEventBase &
  (
    | { type: 'checkout.completed'; data: CheckoutCompleted }
    | { type: 'subscription.upsert'; data: Subscription }
    | { type: 'subscription.deleted'; data: Subscription }
    | { type: 'subscription.trial_will_end'; data: Subscription }
    | { type: 'payment.succeeded'; data: Invoice }
    | { type: 'payment.failed'; data: Invoice }
    | { type: 'customer.deleted'; data: CustomerRef }
    | { type: 'unknown'; data: unknown }
  )

/** Options for `createCheckoutSession`. Provider-neutral. */
export interface CheckoutOptions {
  priceId: string
  successUrl: string
  cancelUrl: string
  mode?: 'subscription' | 'payment'
  trialDays?: number
  allowPromotionCodes?: boolean
  /** Defaults to `tenant.id`. Threaded back on the resulting subscription. */
  clientReferenceId?: string
}

/** Options for `createBillingPortalSession`. */
export interface PortalOptions {
  returnUrl: string
}

/** Options for `reportUsage`. */
export interface UsageOptions {
  /** Custom idempotency key. Default: `<tenant>:<meter>:<minute-bucket>`. */
  idempotencyKey?: string
  /** Epoch seconds for the usage event. Default: now. */
  timestampSeconds?: number
}
