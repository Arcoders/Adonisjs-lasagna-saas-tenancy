import type Stripe from 'stripe'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { isProductionNodeEnv, readBooleanEnvFlag } from '@adonisjs-lasagna/saas-tenancy/sdk'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import BillingException from '../../exceptions/billing_exception.js'
import { DEFAULT_STRIPE_API_VERSION } from '../../stripe_api_version.js'
import type { BillingProviderContract } from '../../contracts/billing_provider_contract.js'
import { BILLING_CONTRACT_VERSION } from '../../constants.js'
import type {
  BillingCapability,
  BillingWebhookEvent,
  CheckoutOptions,
  Customer,
  ListSubscriptionsOptions,
  PortalOptions,
  Price,
  Subscription,
} from '../../contracts/types.js'
import { toCustomer, toSubscription } from './stripe_mapper.js'
import { toBillingWebhookEvent } from './stripe_webhook_mapper.js'

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_NETWORK_RETRIES = 3

/** Tolerance (s) for webhook timestamp skew. Pinned, matching Stripe's default. */
const WEBHOOK_TOLERANCE_SECONDS = 300

const STRIPE_CAPABILITIES: ReadonlySet<BillingCapability> = new Set<BillingCapability>([
  'checkout',
  'billing_portal',
  'usage_metering',
  'event_retrieval',
  'price_lookup',
  'subscription_cancel',
  'subscription_cancel_immediate',
  'subscription_list',
  'subscription_update',
])

/**
 * The Stripe billing driver. Holds the lazily-loaded Stripe SDK and performs
 * all remote calls + native-to-neutral mapping. It owns no database state. The
 * mirror tables, audit rows, and plan assignment stay in `BillingService`.
 *
 * The package never imports `stripe` statically (only `import type`), so hosts
 * on another provider pay nothing for the SDK.
 */
export default class StripeDriver implements BillingProviderContract {
  readonly name = 'stripe' as const
  readonly contractVersion = BILLING_CONTRACT_VERSION

  #stripe: Stripe | null = null

  supports(capability: BillingCapability): boolean {
    return STRIPE_CAPABILITIES.has(capability)
  }

  async verifyConfig(): Promise<void> {
    const cfg = getConfig().billing
    if (!cfg?.stripe) {
      throw new BillingException('config_missing', 'config.billing.stripe is not configured')
    }

    await this.#getStripe() // throws peer_missing if the SDK isn't installed

    const apiKey = cfg.stripe.apiKey ?? ''
    // Use the framework's prod/production normalization, not a raw NODE_ENV compare:
    // on NODE_ENV=prod (which AdonisJS treats as production) a bare === 'production'
    // would wrongly ALLOW a test key and REJECT a live key.
    const isProduction = isProductionNodeEnv()
    const isTestKey = apiKey.startsWith('sk_test_')
    const isLiveKey = apiKey.startsWith('sk_live_')

    if (isProduction && isTestKey) {
      throw new BillingException(
        'test_in_production',
        'STRIPE_API_KEY is a test key but NODE_ENV=production. Refusing to boot — set a live key or revert NODE_ENV.'
      )
    }
    if (!isProduction && isLiveKey && !readBooleanEnvFlag('STRIPE_ALLOW_LIVE_IN_DEV')) {
      throw new BillingException(
        'live_key_outside_production',
        '[billing] STRIPE_API_KEY is a LIVE key but NODE_ENV is not "production". Refusing to boot — set NODE_ENV=production or STRIPE_ALLOW_LIVE_IN_DEV=true to opt in.'
      )
    }

    const webhookSecret = cfg.stripe.webhookSecret ?? ''
    if (!webhookSecret) {
      throw new BillingException(
        'config_missing',
        'config.billing.stripe.webhookSecret is empty — refusing to boot. Set STRIPE_WEBHOOK_SECRET.'
      )
    }
    if (!webhookSecret.startsWith('whsec_')) {
      throw new BillingException(
        'config_missing',
        'config.billing.stripe.webhookSecret does not start with "whsec_" — likely the wrong env var pasted into STRIPE_WEBHOOK_SECRET.'
      )
    }
  }

  async ensureCustomer(tenant: TenantModelContract): Promise<Customer> {
    const stripe = await this.#getStripe()
    try {
      const customer = await stripe.customers.create(
        {
          metadata: { tenantId: tenant.id },
          ...(tenant.email ? { email: tenant.email } : {}),
          ...(tenant.name ? { name: tenant.name } : {}),
        },
        { idempotencyKey: `tenant:${tenant.id}:create-customer` }
      )
      return toCustomer(customer)
    } catch (err) {
      throw BillingException.fromStripeError(err, 'failed to create Stripe customer')
    }
  }

  async createCheckoutSession(
    tenant: TenantModelContract,
    providerCustomerId: string,
    opts: CheckoutOptions
  ): Promise<{ url: string; id: string }> {
    const stripe = await this.#getStripe()
    try {
      const session = await stripe.checkout.sessions.create({
        mode: opts.mode ?? 'subscription',
        customer: providerCustomerId,
        client_reference_id: opts.clientReferenceId ?? tenant.id,
        line_items: [{ price: opts.priceId, quantity: 1 }],
        success_url: opts.successUrl,
        cancel_url: opts.cancelUrl,
        allow_promotion_codes: opts.allowPromotionCodes ?? false,
        ...(opts.mode === 'subscription' && opts.trialDays
          ? { subscription_data: { trial_period_days: opts.trialDays } }
          : {}),
        // Fiscal opt-in: let Stripe compute tax (Stripe Tax). The provider does
        // the math; we only snapshot the result. Requires Stripe Tax enabled +
        // a customer address / tax id on the customer.
        ...(getConfig().billing?.fiscal?.automaticTax ? { automatic_tax: { enabled: true } } : {}),
        metadata: { tenantId: tenant.id },
      })
      if (!session.url) {
        throw new BillingException('api_error', 'Stripe Checkout did not return a URL', {
          status: 500,
        })
      }
      return { url: session.url, id: session.id }
    } catch (err) {
      if (err instanceof BillingException) throw err
      throw BillingException.fromStripeError(err, 'failed to create checkout session')
    }
  }

  async createBillingPortalSession(
    providerCustomerId: string,
    opts: PortalOptions
  ): Promise<{ url: string }> {
    const stripe = await this.#getStripe()
    try {
      const session = await stripe.billingPortal.sessions.create({
        customer: providerCustomerId,
        return_url: opts.returnUrl,
      })
      return { url: session.url }
    } catch (err) {
      throw BillingException.fromStripeError(err, 'failed to create billing portal session')
    }
  }

  async reportUsage(
    providerCustomerId: string,
    meter: { eventName: string },
    quantity: number,
    opts: { idempotencyKey: string; timestampSeconds: number }
  ): Promise<void> {
    const stripe = await this.#getStripe()
    try {
      await stripe.billing.meterEvents.create(
        {
          event_name: meter.eventName,
          payload: {
            stripe_customer_id: providerCustomerId,
            value: String(quantity),
          },
          timestamp: opts.timestampSeconds,
        },
        { idempotencyKey: opts.idempotencyKey }
      )
    } catch (err) {
      throw BillingException.fromStripeError(err, 'failed to report meter event')
    }
  }

  async cancelSubscription(
    providerSubscriptionId: string,
    opts?: { atPeriodEnd?: boolean }
  ): Promise<void> {
    const stripe = await this.#getStripe()
    try {
      if (opts?.atPeriodEnd) {
        await stripe.subscriptions.update(providerSubscriptionId, { cancel_at_period_end: true })
      } else {
        await stripe.subscriptions.cancel(providerSubscriptionId)
      }
    } catch (err) {
      throw BillingException.fromStripeError(err, 'failed to cancel subscription')
    }
  }

  async changePlan(providerSubscriptionId: string, opts: { priceId: string }): Promise<void> {
    const stripe = await this.#getStripe()
    try {
      // Swap the price on the subscription's existing item so this is an
      // upgrade/downgrade, not a second subscription. Proration is left to
      // Stripe's default behavior for the account.
      //
      // Single-item assumption: we target items.data[0]. For multi-item /
      // metered subscriptions (a base plan plus a metered add-on) the base plan
      // may not be the first item. Those need per-item targeting and should be
      // driven through the provider directly until that lands.
      const sub = await stripe.subscriptions.retrieve(providerSubscriptionId)
      const itemId = sub.items?.data?.[0]?.id
      if (!itemId) {
        throw new BillingException(
          'invalid_stripe_request',
          `subscription "${providerSubscriptionId}" has no items to update`
        )
      }
      await stripe.subscriptions.update(
        providerSubscriptionId,
        {
          items: [{ id: itemId, price: opts.priceId }],
          proration_behavior: 'create_prorations',
        },
        {
          // Deterministic so a retried changePlan converges on one change at the
          // provider instead of stacking proration line items.
          idempotencyKey: `subscription:${providerSubscriptionId}:change-plan:${opts.priceId}`,
        }
      )
    } catch (err) {
      if (err instanceof BillingException) throw err
      throw BillingException.fromStripeError(err, 'failed to change subscription plan')
    }
  }

  async resolvePriceProduct(priceId: string): Promise<Price | null> {
    const stripe = await this.#getStripe()
    try {
      const price = await stripe.prices.retrieve(priceId)
      const productId =
        typeof price.product === 'string' ? price.product : (price.product?.id ?? null)
      return { id: price.id, productId }
    } catch (err) {
      throw BillingException.fromStripeError(
        err,
        `priceId "${priceId}" could not be verified against Stripe`
      )
    }
  }

  async *listSubscriptions(opts?: ListSubscriptionsOptions): AsyncIterable<Subscription> {
    const stripe = await this.#getStripe()
    const params: Record<string, unknown> = { status: 'all', limit: 100 }
    if (opts?.customerId) params.customer = opts.customerId
    if (typeof opts?.createdAfter === 'number') params.created = { gte: opts.createdAfter }
    const page = stripe.subscriptions.list(
      params as Parameters<typeof stripe.subscriptions.list>[0]
    )
    for await (const sub of page) {
      yield toSubscription(sub)
    }
  }

  async parseWebhookEvent(rawBody: string, signature: string | null): Promise<BillingWebhookEvent> {
    const cfg = getConfig().billing
    if (!cfg?.stripe) {
      throw new BillingException('config_missing', 'config.billing.stripe is not configured')
    }
    if (!signature) {
      throw new BillingException('invalid_signature', 'missing stripe-signature header', {
        status: 400,
      })
    }
    const stripe = await this.#getStripe()
    let event: Stripe.Event
    try {
      event = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        cfg.stripe.webhookSecret,
        WEBHOOK_TOLERANCE_SECONDS
      )
    } catch (err) {
      throw BillingException.fromStripeError(err, 'webhook signature verification failed')
    }
    return toBillingWebhookEvent(event)
  }

  async retrieveEvent(eventId: string): Promise<BillingWebhookEvent | null> {
    const stripe = await this.#getStripe()
    try {
      const event = await stripe.events.retrieve(eventId)
      return toBillingWebhookEvent(event)
    } catch (err) {
      // Aged-out events return resource_missing/404. Signal the caller to fall
      // back to the persisted replay payload. Every other failure surfaces.
      const e = (err ?? {}) as { code?: string; statusCode?: number }
      if (e.code === 'resource_missing' || e.statusCode === 404) return null
      throw BillingException.fromStripeError(err, `failed to retrieve event ${eventId}`)
    }
  }

  async healthCheck(): Promise<void> {
    const stripe = await this.#getStripe()
    await stripe.balance.retrieve()
  }

  /** @internal advanced host access / tests. Returns the raw Stripe SDK. */
  async getClient(): Promise<Stripe> {
    return this.#getStripe()
  }

  /** @internal inject a mock SDK (e.g. `MockStripe`). */
  __setStripeForTests(client: unknown): void {
    this.#stripe = client as Stripe
  }

  /** @internal drop the cached SDK between test cases. */
  __resetForTests(): void {
    this.#stripe = null
  }

  async #getStripe(): Promise<Stripe> {
    if (this.#stripe) return this.#stripe
    const cfg = getConfig().billing
    if (!cfg?.stripe) {
      throw new BillingException('config_missing', 'config.billing.stripe is not configured')
    }

    let StripeCtor: typeof Stripe
    try {
      const mod = (await import('stripe')) as unknown as { default: typeof Stripe }
      StripeCtor = mod.default ?? (mod as unknown as typeof Stripe)
    } catch {
      throw new BillingException(
        'peer_missing',
        '[billing] config.billing is set but the `stripe` peer dep is not installed. Run: npm install stripe@^22'
      )
    }

    this.#stripe = new StripeCtor(cfg.stripe.apiKey, {
      apiVersion: (cfg.stripe.apiVersion ?? DEFAULT_STRIPE_API_VERSION) as NonNullable<
        NonNullable<ConstructorParameters<typeof StripeCtor>[1]>['apiVersion']
      >,
      timeout: cfg.stripe.timeout ?? DEFAULT_TIMEOUT_MS,
      maxNetworkRetries: cfg.stripe.maxNetworkRetries ?? DEFAULT_NETWORK_RETRIES,
    })
    return this.#stripe
  }
}
