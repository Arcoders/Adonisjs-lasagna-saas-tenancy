import { createHmac, timingSafeEqual } from 'node:crypto'
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
  Price,
} from '../../contracts/types.js'
import { toBillingWebhookEvent } from './paddle_mapper.js'

/** Tolerance (s) for the Paddle-Signature timestamp. */
const WEBHOOK_TOLERANCE_SECONDS = 300

const PADDLE_CAPABILITIES: ReadonlySet<BillingCapability> = new Set<BillingCapability>([
  'checkout',
  'price_lookup',
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
 * Paddle Billing driver. Talks to the Paddle REST API directly (no SDK
 * method-name coupling) and verifies the `Paddle-Signature` webhook HMAC.
 *
 * Capabilities: checkout, price lookup, subscription cancel. Paddle's customer
 * portal and usage metering use flows that don't map cleanly onto the neutral
 * contract, so they are reported unsupported (the service throws a clear
 * `unsupported_by_driver` rather than faking them).
 *
 * NOTE: exercise against the Paddle sandbox before production — the
 * `*_real.spec.ts` smoke test covers this when `PADDLE_TEST_API_KEY` is set.
 */
export default class PaddleDriver implements BillingProviderContract {
  readonly name = 'paddle' as const

  supports(capability: BillingCapability): boolean {
    return PADDLE_CAPABILITIES.has(capability)
  }

  #config() {
    const cfg = getConfig().billing?.paddle
    if (!cfg?.apiKey) {
      throw new BillingException('config_missing', 'config.billing.paddle is not configured')
    }
    return cfg
  }

  #baseUrl(): string {
    return this.#config().environment === 'production'
      ? 'https://api.paddle.com'
      : 'https://sandbox-api.paddle.com'
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const cfg = this.#config()
    let res: Response
    try {
      res = await fetch(`${this.#baseUrl()}${path}`, {
        method,
        headers: {
          'Authorization': `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (err) {
      throw new BillingException('network_error', 'Paddle API connection error', {
        status: 503,
        cause: err,
      })
    }
    const json = (await res.json().catch(() => ({}))) as { data?: T; error?: { detail?: string } }
    if (!res.ok) {
      throw new BillingException(
        codeForStatus(res.status),
        `Paddle API ${method} ${path} failed: ${json.error?.detail ?? res.statusText}`,
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
        'config.billing.paddle.webhookSecret is empty — set PADDLE_WEBHOOK_SECRET.'
      )
    }
  }

  async ensureCustomer(tenant: TenantModelContract): Promise<Customer> {
    if (!tenant.email) {
      throw new BillingException(
        'tenant_not_resolvable',
        'Paddle requires an email to create a customer, but the tenant has none'
      )
    }
    const data = await this.#request<{ id: string }>('POST', '/customers', {
      email: tenant.email,
      ...(tenant.name ? { name: tenant.name } : {}),
      custom_data: { tenantId: tenant.id },
    })
    return { providerCustomerId: data.id, currency: null, defaultPaymentMethod: null }
  }

  async createCheckoutSession(
    tenant: TenantModelContract,
    providerCustomerId: string,
    opts: CheckoutOptions
  ): Promise<{ url: string; id: string }> {
    const data = await this.#request<{ id: string; checkout?: { url?: string | null } }>(
      'POST',
      '/transactions',
      {
        items: [{ price_id: opts.priceId, quantity: 1 }],
        customer_id: providerCustomerId,
        custom_data: { tenantId: opts.clientReferenceId ?? tenant.id },
        checkout: { url: opts.successUrl },
      }
    )
    const url = data.checkout?.url
    if (!url) {
      throw new BillingException(
        'api_error',
        'Paddle transaction did not return a checkout URL — configure a default payment link in Paddle',
        { status: 500 }
      )
    }
    return { url, id: data.id }
  }

  async cancelSubscription(
    providerSubscriptionId: string,
    opts?: { atPeriodEnd?: boolean }
  ): Promise<void> {
    await this.#request('POST', `/subscriptions/${providerSubscriptionId}/cancel`, {
      effective_from: opts?.atPeriodEnd ? 'next_billing_period' : 'immediately',
    })
  }

  async resolvePriceProduct(priceId: string): Promise<Price | null> {
    const data = await this.#request<{ id: string; product_id?: string | null }>(
      'GET',
      `/prices/${priceId}`
    )
    return { id: data.id, productId: data.product_id ?? null }
  }

  verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
    if (!signature) return false
    const parts = Object.fromEntries(
      signature.split(';').map((kv) => {
        const [k, v] = kv.split('=')
        return [k?.trim(), v?.trim()]
      })
    ) as { ts?: string; h1?: string }
    if (!parts.ts || !parts.h1) return false

    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number.parseInt(parts.ts, 10))
    if (!Number.isFinite(ageSeconds) || ageSeconds > WEBHOOK_TOLERANCE_SECONDS) return false

    const expected = createHmac('sha256', this.#config().webhookSecret)
      .update(`${parts.ts}:${rawBody}`, 'utf8')
      .digest('hex')
    const a = Buffer.from(expected)
    const b = Buffer.from(parts.h1)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  async parseWebhookEvent(rawBody: string, signature: string | null): Promise<BillingWebhookEvent> {
    if (!this.verifyWebhookSignature(rawBody, signature)) {
      throw new BillingException('invalid_signature', 'Paddle webhook signature mismatch', {
        status: 400,
      })
    }
    return toBillingWebhookEvent(JSON.parse(rawBody))
  }
}
