import { createHmac, timingSafeEqual } from 'node:crypto'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import BillingException from '../exceptions/billing_exception.js'
import type { BillingProviderContract } from '../contracts/billing_provider_contract.js'
import { BILLING_CONTRACT_VERSION } from '../constants.js'
import type {
  BillingCapability,
  BillingWebhookEvent,
  CheckoutOptions,
  Customer,
  ListSubscriptionsOptions,
  PortalOptions,
  Price,
  Subscription,
} from '../contracts/types.js'

interface RecordedUsage {
  providerCustomerId: string
  eventName: string
  quantity: number
  idempotencyKey: string
  timestampSeconds: number
}

/**
 * In-memory billing driver for tests. The "second implementation" that proves
 * the abstraction without any SDK or network — register it as the active
 * driver to exercise `BillingService` and the dispatcher hermetically.
 *
 * Webhook signing is a plain HMAC-SHA256 over the raw body (hex digest in the
 * signature header), so `signMockWebhook()` + `parseWebhookEvent()` round-trip
 * without a provider account. The body is a JSON-serialised
 * `BillingWebhookEvent` (minus `provider`), so tests author neutral events
 * directly.
 */
export default class MockBillingDriver implements BillingProviderContract {
  readonly name = 'mock' as const
  readonly contractVersion = BILLING_CONTRACT_VERSION

  readonly #secret: string
  #seq = 0
  readonly usage: RecordedUsage[] = []
  readonly canceled: { id: string; atPeriodEnd: boolean }[] = []
  readonly #events = new Map<string, BillingWebhookEvent>()
  readonly #priceProducts = new Map<string, string | null>()
  readonly #subscriptions: Subscription[] = []

  constructor(opts: { webhookSecret?: string } = {}) {
    this.#secret = opts.webhookSecret ?? 'whsec_mock'
  }

  supports(_capability: BillingCapability): boolean {
    return true
  }

  async verifyConfig(): Promise<void> {}

  async ensureCustomer(tenant: TenantModelContract): Promise<Customer> {
    return {
      providerCustomerId: `cus_mock_${tenant.id}`,
      currency: null,
      defaultPaymentMethod: null,
      country: null,
    }
  }

  async createCheckoutSession(
    _tenant: TenantModelContract,
    providerCustomerId: string,
    opts: CheckoutOptions
  ): Promise<{ url: string; id: string }> {
    const id = `cs_mock_${++this.#seq}`
    return { url: `https://mock.test/checkout/${id}?c=${providerCustomerId}&p=${opts.priceId}`, id }
  }

  async createBillingPortalSession(
    providerCustomerId: string,
    opts: PortalOptions
  ): Promise<{ url: string }> {
    return { url: `https://mock.test/portal/${providerCustomerId}?return=${opts.returnUrl}` }
  }

  async reportUsage(
    providerCustomerId: string,
    meter: { eventName: string },
    quantity: number,
    opts: { idempotencyKey: string; timestampSeconds: number }
  ): Promise<void> {
    this.usage.push({ providerCustomerId, eventName: meter.eventName, quantity, ...opts })
  }

  async cancelSubscription(
    providerSubscriptionId: string,
    opts?: { atPeriodEnd?: boolean }
  ): Promise<void> {
    this.canceled.push({ id: providerSubscriptionId, atPeriodEnd: opts?.atPeriodEnd ?? false })
  }

  async resolvePriceProduct(priceId: string): Promise<Price | null> {
    if (!this.#priceProducts.has(priceId)) return null
    return { id: priceId, productId: this.#priceProducts.get(priceId) ?? null }
  }

  async *listSubscriptions(opts?: ListSubscriptionsOptions): AsyncIterable<Subscription> {
    for (const sub of this.#subscriptions) {
      if (opts?.customerId && sub.customerId !== opts.customerId) continue
      yield sub
    }
  }

  verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
    if (!signature) return false
    const expected = createHmac('sha256', this.#secret).update(rawBody, 'utf8').digest('hex')
    const a = Buffer.from(expected)
    const b = Buffer.from(signature)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  async parseWebhookEvent(rawBody: string, signature: string | null): Promise<BillingWebhookEvent> {
    if (!this.verifyWebhookSignature(rawBody, signature)) {
      throw new BillingException('invalid_signature', 'mock webhook signature mismatch', {
        status: 400,
      })
    }
    const parsed = JSON.parse(rawBody) as Omit<BillingWebhookEvent, 'provider'>
    return { ...parsed, provider: 'mock' } as BillingWebhookEvent
  }

  async retrieveEvent(eventId: string): Promise<BillingWebhookEvent | null> {
    return this.#events.get(eventId) ?? null
  }

  async healthCheck(): Promise<void> {}

  /* ----------------------------- test helpers ----------------------------- */

  /** Produce the signature header for a raw body (HMAC-SHA256 hex). */
  signMockWebhook(rawBody: string): string {
    return createHmac('sha256', this.#secret).update(rawBody, 'utf8').digest('hex')
  }

  /** Seed an event so `retrieveEvent` can return it (tamper-guard tests). */
  injectEvent(event: BillingWebhookEvent): void {
    this.#events.set(event.id, event)
  }

  /** Seed a price→product mapping for `resolvePriceProduct`. */
  injectPrice(priceId: string, productId: string | null): void {
    this.#priceProducts.set(priceId, productId)
  }

  /** Seed a subscription so `listSubscriptions` enumerates it (reconcile tests). */
  injectSubscription(subscription: Subscription): void {
    this.#subscriptions.push(subscription)
  }
}
