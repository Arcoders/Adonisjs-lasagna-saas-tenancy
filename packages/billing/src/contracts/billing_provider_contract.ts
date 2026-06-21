import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type {
  BillingCapability,
  BillingDriverName,
  BillingWebhookEvent,
  CheckoutOptions,
  Customer,
  ListSubscriptionsOptions,
  PortalOptions,
  Price,
  Subscription,
  UsageOptions,
} from './types.js'

/**
 * The contract every billing provider must satisfy. A driver encapsulates the
 * answer to: "how do I talk to this payment provider, and how do I translate
 * its webhooks into the package's neutral event model?".
 *
 * This is the public extension seam — third parties implement it to add a
 * provider, register it on `BillingDriverRegistry`, and select it with
 * `config.billing.driver`. It mirrors `IsolationDriver`.
 *
 * Capability-gated methods (`createBillingPortalSession`, `reportUsage`,
 * `cancelSubscription`, `resolvePriceProduct`, `retrieveEvent`) are only
 * invoked when `supports()` returns true for the matching capability;
 * `BillingService` throws `unsupported_by_driver` otherwise. Implementations
 * may still declare them (throwing) or leave them off the prototype.
 */
export interface BillingProviderContract {
  readonly name: BillingDriverName

  /** Whether this driver implements the given optional capability. */
  supports(capability: BillingCapability): boolean

  /**
   * Boot-time validation of the driver's config slice. Runs from
   * `BillingProvider.boot()` so a missing SDK / wrong-mode key / malformed
   * secret fails at boot, not at the first webhook. Idempotent.
   */
  verifyConfig(): Promise<void>

  /**
   * Idempotent, race-safe customer creation. Implementations should use a
   * provider-side idempotency key so two concurrent workers converge on one
   * remote customer.
   */
  ensureCustomer(tenant: TenantModelContract): Promise<Customer>

  /**
   * Build a hosted checkout URL the host can redirect the buyer to.
   * `providerCustomerId` is resolved by `BillingService.ensureCustomer` before
   * this is called, so the driver never has to touch the local mirror.
   */
  createCheckoutSession(
    tenant: TenantModelContract,
    providerCustomerId: string,
    opts: CheckoutOptions
  ): Promise<{ url: string; id: string }>

  /**
   * Build a customer/billing-portal URL. Capability: `billing_portal`.
   * `providerCustomerId` is the value persisted on `billing_customers`.
   */
  createBillingPortalSession?(
    providerCustomerId: string,
    opts: PortalOptions
  ): Promise<{ url: string }>

  /**
   * Report a usage/meter event. Capability: `usage_metering`. The audit row in
   * `billing_usage_events` is owned by `BillingService` — the driver only makes
   * the remote call (idempotently, keyed by `idempotencyKey`).
   */
  reportUsage?(
    providerCustomerId: string,
    meter: { eventName: string },
    quantity: number,
    opts: Required<Pick<UsageOptions, 'idempotencyKey' | 'timestampSeconds'>>
  ): Promise<void>

  /**
   * Cancel (or detach) a subscription on tenant hard-delete. Capability:
   * `subscription_cancel`. `atPeriodEnd` chooses immediate vs end-of-period.
   */
  cancelSubscription?(
    providerSubscriptionId: string,
    opts?: { atPeriodEnd?: boolean }
  ): Promise<void>

  /**
   * Resolve a price id to its product id, for the checkout price allowlist
   * fallback (operators who map products rather than prices). Capability:
   * `price_lookup`. Returns `null` when the price has no product.
   */
  resolvePriceProduct?(priceId: string): Promise<Price | null>

  /**
   * Enumerate the provider's subscriptions as neutral `Subscription`s, paging
   * internally. Capability: `subscription_list`. Drives the `tenant:billing:sync`
   * forward pass (provider → local mirror). Drivers without an enumerable
   * subscription endpoint omit this; `sync`/`doctor` then warn that forward
   * drift-recovery is unavailable for that provider.
   */
  listSubscriptions?(opts?: ListSubscriptionsOptions): AsyncIterable<Subscription>

  /**
   * Optional synchronous signature check, for drivers whose scheme is a plain
   * `crypto` HMAC needing no SDK (Paddle `Paddle-Signature`, Lemon Squeezy
   * `X-Signature`). Must not throw — return false on mismatch. Stripe folds
   * verification into `parseWebhookEvent` (the SDK call is async), so it omits
   * this. Provided mainly for tests/diagnostics.
   */
  verifyWebhookSignature?(rawBody: string, signature: string | null): boolean

  /**
   * Verify + parse a raw webhook body into a neutral event. This is the
   * canonical hot-path entry: it MUST verify the signature and throw
   * `BillingException('invalid_signature')` on failure before parsing. Native
   * types this driver doesn't map become `{ type: 'unknown' }`.
   */
  parseWebhookEvent(rawBody: string, signature: string | null): Promise<BillingWebhookEvent>

  /**
   * Re-fetch an event by id from the provider as a tamper guard. Capability:
   * `event_retrieval`. Drivers without an equivalent endpoint omit this; the
   * pipeline then trusts the signature-verified payload persisted at receive
   * time. Returns `null` when the provider reports the event is gone (aged
   * out) so the caller can fall back to the stored replay payload.
   */
  retrieveEvent?(eventId: string): Promise<BillingWebhookEvent | null>

  /** Lightweight connectivity probe for the health check. Capability: optional. */
  healthCheck?(): Promise<void>
}
