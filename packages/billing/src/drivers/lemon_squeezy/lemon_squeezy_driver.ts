import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { safeFetch } from '@adonisjs-lasagna/saas-tenancy/safe-fetch'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import BillingException from '../../exceptions/billing_exception.js'
import type { BillingErrorCode } from '../../exceptions/billing_exception.js'
import type { BillingProviderContract } from '../../contracts/billing_provider_contract.js'
import { BILLING_CONTRACT_VERSION } from '../../constants.js'
import type {
  BillingCapability,
  BillingWebhookEvent,
  CheckoutOptions,
  Customer,
  ListSubscriptionsOptions,
  Subscription,
} from '../../contracts/types.js'
import { toBillingWebhookEvent, toSubscription } from './lemon_squeezy_mapper.js'

const LS_API = 'https://api.lemonsqueezy.com/v1'
const LS_MEDIA_TYPE = 'application/vnd.api+json'

const LS_CAPABILITIES: ReadonlySet<BillingCapability> = new Set<BillingCapability>([
  'checkout',
  'subscription_cancel',
  'subscription_list',
])

function codeForStatus(status: number): BillingErrorCode {
  if (status === 401) return 'authentication_failed'
  if (status === 403) return 'permission_denied'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'api_error'
  return 'invalid_stripe_request'
}

/**
 * Lemon Squeezy driver. Talks to the LS JSON:API directly and verifies the
 * `X-Signature` webhook HMAC (hex SHA-256 of the raw body).
 *
 * Capabilities: checkout, subscription cancel. LS usage metering and the
 * customer-portal link are subscription-scoped (not customer-scoped) and don't
 * map onto the neutral contract, so they are reported unsupported.
 *
 * NOTE: exercise against an LS test store before production. The
 * `*_real.spec.ts` smoke test covers this when `LEMONSQUEEZY_TEST_API_KEY` is set.
 */
export default class LemonSqueezyDriver implements BillingProviderContract {
  readonly name = 'lemonsqueezy' as const
  readonly contractVersion = BILLING_CONTRACT_VERSION

  supports(capability: BillingCapability): boolean {
    return LS_CAPABILITIES.has(capability)
  }

  #config() {
    const cfg = getConfig().billing?.lemonSqueezy
    if (!cfg?.apiKey) {
      throw new BillingException('config_missing', 'config.billing.lemonSqueezy is not configured')
    }
    return cfg
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const cfg = this.#config()
    let res: Response
    try {
      // Trusted-host mode: api.lemonsqueezy.com is a first-party static host behind
      // a CDN. safeFetch asserts host + https and shares redirect/timeout handling
      // without pinning (the allowlist lives in safe_fetch.ts).
      res = await safeFetch(`${LS_API}${path}`, {
        method,
        headers: {
          'Authorization': `Bearer ${cfg.apiKey}`,
          'Accept': LS_MEDIA_TYPE,
          'Content-Type': LS_MEDIA_TYPE,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        trustedHost: true,
      })
    } catch (err) {
      throw new BillingException('network_error', 'Lemon Squeezy API connection error', {
        status: 503,
        cause: err,
      })
    }
    if (res.status === 204) return undefined as T
    const json = (await res.json().catch(() => ({}))) as {
      data?: T
      errors?: Array<{ detail?: string }>
    }
    if (!res.ok) {
      throw new BillingException(
        codeForStatus(res.status),
        `Lemon Squeezy API ${method} ${path} failed: ${json.errors?.[0]?.detail ?? res.statusText}`,
        { status: res.status }
      )
    }
    return json.data as T
  }

  async verifyConfig(): Promise<void> {
    const cfg = this.#config()
    if (!cfg.webhookSecret) {
      throw new BillingException(
        'config_missing',
        'config.billing.lemonSqueezy.webhookSecret is empty — set LEMONSQUEEZY_WEBHOOK_SECRET.'
      )
    }
    if (!cfg.storeId) {
      throw new BillingException(
        'config_missing',
        'config.billing.lemonSqueezy.storeId is empty — set LEMONSQUEEZY_STORE_ID.'
      )
    }
  }

  /**
   * Find-or-create. Lemon Squeezy's JSON:API has no idempotency-key header, so
   * we converge concurrent/retried creates ourselves: look the customer up by
   * email first, and if the POST loses a race (LS returns `422 email has
   * already been taken`) re-read and reuse the winner. The realistic
   * sequential-retry path (a webhook redelivery, a double-click) is fully
   * race-safe; a genuinely simultaneous double-create can still leave one
   * orphaned LS customer (no subscription, no charge). It is logged and
   * reconciled by `tenant:billing:sync`. A connection-holding advisory lock was
   * rejected: it would pin a pooled DB connection across the provider HTTP call,
   * and the local `BillingService.ensureCustomer` SELECT fast-path already
   * single-flights per tenant for its whole lifetime.
   */
  async ensureCustomer(tenant: TenantModelContract): Promise<Customer> {
    if (!tenant.email) {
      throw new BillingException(
        'tenant_not_resolvable',
        'Lemon Squeezy requires an email to create a customer, but the tenant has none'
      )
    }

    const existingId = await this.#findCustomerIdByEmail(tenant.email)
    if (existingId) {
      return {
        providerCustomerId: existingId,
        currency: null,
        defaultPaymentMethod: null,
        country: null,
      }
    }

    try {
      const data = await this.#request<{ id: string | number }>('POST', '/customers', {
        data: {
          type: 'customers',
          attributes: { name: tenant.name ?? tenant.email, email: tenant.email },
          relationships: {
            store: { data: { type: 'stores', id: String(this.#config().storeId) } },
          },
        },
      })
      return {
        providerCustomerId: String(data.id),
        currency: null,
        defaultPaymentMethod: null,
        country: null,
      }
    } catch (err) {
      // 422 = "email has already been taken": a concurrent create won. Re-read
      // and reuse it instead of orphaning a second customer.
      if (err instanceof BillingException && (err as { status?: number }).status === 422) {
        const raced = await this.#findCustomerIdByEmail(tenant.email)
        if (raced) {
          return {
            providerCustomerId: raced,
            currency: null,
            defaultPaymentMethod: null,
            country: null,
          }
        }
      }
      throw err
    }
  }

  /** Look up an LS customer id by email (the store-scoped unique key). */
  async #findCustomerIdByEmail(email: string): Promise<string | null> {
    const list = await this.#request<Array<{ id: string | number }>>(
      'GET',
      `/customers?filter[email]=${encodeURIComponent(email)}`
    )
    const first = Array.isArray(list) ? list[0] : null
    return first ? String(first.id) : null
  }

  async createCheckoutSession(
    tenant: TenantModelContract,
    _providerCustomerId: string,
    opts: CheckoutOptions
  ): Promise<{ url: string; id: string }> {
    const data = await this.#request<{ id: string | number; attributes?: { url?: string } }>(
      'POST',
      '/checkouts',
      {
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: {
              email: tenant.email ?? undefined,
              custom: { tenant_id: opts.clientReferenceId ?? tenant.id },
            },
            product_options: { redirect_url: opts.successUrl },
          },
          relationships: {
            store: { data: { type: 'stores', id: String(this.#config().storeId) } },
            variant: { data: { type: 'variants', id: String(opts.priceId) } },
          },
        },
      }
    )
    const url = data.attributes?.url
    if (!url) {
      throw new BillingException('api_error', 'Lemon Squeezy did not return a checkout URL', {
        status: 500,
      })
    }
    return { url, id: String(data.id) }
  }

  async cancelSubscription(providerSubscriptionId: string): Promise<void> {
    // LS cancellation is always at period end (the subscription stays active
    // until `ends_at`). DELETE is the documented cancel verb.
    await this.#request('DELETE', `/subscriptions/${providerSubscriptionId}`)
  }

  async *listSubscriptions(opts?: ListSubscriptionsOptions): AsyncIterable<Subscription> {
    // LS has no `created_after` filter on subscriptions; `createdAfter` is a
    // Stripe-only scan optimization and is ignored here (full scan is correct).
    let pageNum = 1
    for (;;) {
      const qs = new URLSearchParams({
        'filter[store_id]': String(this.#config().storeId),
        'page[size]': '100',
        'page[number]': String(pageNum),
      })
      if (opts?.customerId) qs.set('filter[customer_id]', opts.customerId)
      const page = await this.#listSubscriptionPage(`/subscriptions?${qs.toString()}`)
      for (const item of page.data) {
        yield toSubscription(item)
      }
      if (pageNum >= page.lastPage) break
      pageNum += 1
    }
  }

  /**
   * GET one JSON:API page of subscriptions. Separate from `#request` because
   * that helper discards the `meta.page` pagination block.
   */
  async #listSubscriptionPage(
    path: string
  ): Promise<{ data: Parameters<typeof toSubscription>[0][]; lastPage: number }> {
    const cfg = this.#config()
    let res: Response
    try {
      res = await safeFetch(`${LS_API}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: LS_MEDIA_TYPE },
        trustedHost: true,
      })
    } catch (err) {
      throw new BillingException('network_error', 'Lemon Squeezy API connection error', {
        status: 503,
        cause: err,
      })
    }
    const json = (await res.json().catch(() => ({}))) as {
      data?: Parameters<typeof toSubscription>[0][]
      meta?: { page?: { lastPage?: number } }
      errors?: Array<{ detail?: string }>
    }
    if (!res.ok) {
      throw new BillingException(
        codeForStatus(res.status),
        `Lemon Squeezy API GET /subscriptions failed: ${json.errors?.[0]?.detail ?? res.statusText}`,
        { status: res.status }
      )
    }
    return { data: json.data ?? [], lastPage: json.meta?.page?.lastPage ?? 1 }
  }

  verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
    if (!signature) return false
    const expected = createHmac('sha256', this.#config().webhookSecret)
      .update(rawBody, 'utf8')
      .digest('hex')
    const a = Buffer.from(expected)
    const b = Buffer.from(signature)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  async parseWebhookEvent(rawBody: string, signature: string | null): Promise<BillingWebhookEvent> {
    if (!this.verifyWebhookSignature(rawBody, signature)) {
      throw new BillingException('invalid_signature', 'Lemon Squeezy webhook signature mismatch', {
        status: 400,
      })
    }
    // LS bodies carry no event id; synthesise a deterministic one from the body
    // so the idempotency ledger collapses LS retries of the same delivery.
    const eventId = `lsq_${createHash('sha256').update(rawBody, 'utf8').digest('hex').slice(0, 48)}`
    return toBillingWebhookEvent(JSON.parse(rawBody), eventId)
  }
}
