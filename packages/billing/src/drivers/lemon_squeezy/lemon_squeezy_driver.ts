import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import BillingException from '../../exceptions/billing_exception.js'
import type { BillingErrorCode } from '../../exceptions/billing_exception.js'
import type { BillingProviderContract } from '../../contracts/billing_provider_contract.js'
import type {
  BillingCapability,
  BillingWebhookEvent,
  CheckoutOptions,
  Customer,
} from '../../contracts/types.js'
import { toBillingWebhookEvent } from './lemon_squeezy_mapper.js'

const LS_API = 'https://api.lemonsqueezy.com/v1'
const LS_MEDIA_TYPE = 'application/vnd.api+json'

const LS_CAPABILITIES: ReadonlySet<BillingCapability> = new Set<BillingCapability>([
  'checkout',
  'subscription_cancel',
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
 * NOTE: exercise against an LS test store before production — the
 * `*_real.spec.ts` smoke test covers this when `LEMONSQUEEZY_TEST_API_KEY` is set.
 */
export default class LemonSqueezyDriver implements BillingProviderContract {
  readonly name = 'lemonsqueezy' as const

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
      res = await fetch(`${LS_API}${path}`, {
        method,
        headers: {
          'Authorization': `Bearer ${cfg.apiKey}`,
          'Accept': LS_MEDIA_TYPE,
          'Content-Type': LS_MEDIA_TYPE,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
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

  async ensureCustomer(tenant: TenantModelContract): Promise<Customer> {
    if (!tenant.email) {
      throw new BillingException(
        'tenant_not_resolvable',
        'Lemon Squeezy requires an email to create a customer, but the tenant has none'
      )
    }
    const data = await this.#request<{ id: string | number }>('POST', '/customers', {
      data: {
        type: 'customers',
        attributes: { name: tenant.name ?? tenant.email, email: tenant.email },
        relationships: {
          store: { data: { type: 'stores', id: String(this.#config().storeId) } },
        },
      },
    })
    return { providerCustomerId: String(data.id), currency: null, defaultPaymentMethod: null }
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
