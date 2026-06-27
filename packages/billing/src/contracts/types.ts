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

import type { BillingDriverChoice } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * The shipped driver names, plus any custom name a host registers via
 * `BillingDriverRegistry.register()`. Canonical definition is core's
 * `BillingDriverChoice` (the value `config.billing.driver` accepts); this is the
 * billing-package alias so the two unions can never drift. Guarded by
 * scripts/check-billing-driver-name-canonical.mjs.
 */
export type BillingDriverName = BillingDriverChoice

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
   * The driver can cancel a subscription *immediately* (stop the provider-side
   * billing now), not only at period end. Stripe and Paddle support it; Lemon
   * Squeezy does not, so `BillingService.cancelSubscription` emulates an
   * immediate cancel locally (revoke access now) while LS bills through the
   * period end.
   */
  | 'subscription_cancel_immediate'
  /**
   * The driver can enumerate the provider's subscriptions, so
   * `tenant:billing:sync` can run its forward pass (provider → local mirror) for
   * drift recovery. A driver without it can still be reconciled by the
   * driver-neutral reverse pass (orphaned `tenant_plans` → defaultPlan), but
   * `sync`/`doctor` warn that forward drift-recovery is unavailable rather than
   * implying coverage. Built-in for Stripe, Paddle, and Lemon Squeezy.
   */
  | 'subscription_list'
  /**
   * The driver can push a plan/price change TO the provider (upgrade/downgrade
   * an existing subscription), driving `BillingService.changePlan`. Stripe and
   * Paddle support it; Lemon Squeezy does not (its API has no mid-period item
   * swap), so it omits the capability and `changePlan` throws
   * `unsupported_by_driver`. Distinct from inbound webhook reconciliation
   * (`syncSubscription`), which mirrors changes the provider already made.
   */
  | 'subscription_update'

/**
 * Neutral subscription status. Identical to the original
 * `StripeSubscriptionStatus` set — drivers map their native statuses onto it
 * (Paddle `active|trialing|past_due|paused|canceled`, Lemon Squeezy
 * `on_trial|active|past_due|unpaid|cancelled|expired`, ...).
 */
export const SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

/** Type guard: is `s` one of the known neutral statuses? */
export function isKnownSubscriptionStatus(s: string): s is SubscriptionStatus {
  return (SUBSCRIPTION_STATUSES as readonly string[]).includes(s)
}

/** Neutral customer, as returned by `ensureCustomer`. */
export interface Customer {
  /** The provider's customer id (e.g. Stripe `cus_…`). */
  providerCustomerId: string
  currency: string | null
  defaultPaymentMethod: string | null
  /**
   * ISO 3166-1 alpha-2 country, when the provider exposes it (e.g. Stripe
   * `address.country`). Often null at creation and filled in later by the
   * provider. Persisted to `billing_customers.country_code` only when fiscal
   * features are enabled (the column ships with the opt-in fiscal migration).
   */
  country: string | null
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
  /**
   * `false` when the driver could not map the provider's native status string
   * to a known neutral status (e.g. the provider added a new one). Omitted /
   * `true` means recognized. `syncSubscription` uses this to fail safe: it keeps
   * an existing row's known status rather than overwriting it with a guessed
   * value, and logs for an operator to update the mapping.
   */
  statusRecognized?: boolean
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
  /**
   * Fiscal snapshot fields (integer minor units), populated by the mapper when
   * the provider supplies them (Stripe Tax / Paddle / Lemon Squeezy). These are
   * what the provider charged — we never compute tax. `null` when the provider
   * doesn't break it out. Consumed by the opt-in invoice read model and carried
   * on payment events for reporting.
   */
  subtotal?: number | null
  tax?: number | null
  total?: number | null
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

/** Options for `listSubscriptions`. Provider-neutral. */
export interface ListSubscriptionsOptions {
  /** Restrict the listing to a single provider customer id. */
  customerId?: string
  /** Only consider subscriptions created at/after this epoch-seconds time. */
  createdAfter?: number
}

/** Options for `reportUsage`. */
export interface UsageOptions {
  /** Custom idempotency key. Default: `<tenant>:<meter>:<minute-bucket>`. */
  idempotencyKey?: string
  /** Epoch seconds for the usage event. Default: now. */
  timestampSeconds?: number
}
