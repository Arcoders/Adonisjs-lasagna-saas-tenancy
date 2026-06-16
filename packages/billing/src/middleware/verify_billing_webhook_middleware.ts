import { type HttpRequest } from '@adonisjs/core/http'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import BillingException from '../exceptions/billing_exception.js'
import { getActiveBillingDriver } from '../services/billing/active_billing_driver.js'
import { isWebhookOriginAllowed } from '../services/billing/stripe_ip_allowlist.js'
import type { BillingWebhookEvent } from '../contracts/types.js'

declare module '@adonisjs/core/http' {
  interface HttpRequest {
    /**
     * The verified, provider-agnostic billing event attached by
     * `VerifyBillingWebhookMiddleware`. Always present on the webhook
     * controller; the middleware throws `E_BILLING` before it if verification
     * fails.
     */
    billingEvent?: BillingWebhookEvent
  }
}

/**
 * Middleware: verify an inbound billing webhook via the active driver and
 * attach the parsed neutral event to `request.billingEvent`. An optional IP
 * allowlist runs first (cheap reject).
 *
 * Each driver owns its signature scheme (`stripe-signature`, `Paddle-Signature`,
 * `X-Signature`); the middleware reads the right header per provider and lets
 * `driver.parseWebhookEvent` do verification + parsing in one step.
 *
 * Body access relies on `request.raw()`, which AdonisJS BodyParser preserves
 * regardless of content-type — hosts don't need to disable bodyparser.
 */
export default class VerifyBillingWebhookMiddleware {
  async handle({ request, response }: HttpContext, next: NextFn) {
    const cfg = getConfig().billing
    if (!cfg) {
      throw new BillingException('config_missing', 'config.billing not set — cannot verify webhook')
    }

    if (!isWebhookOriginAllowed(request.ip())) {
      return response.unauthorized({
        code: 'E_BILLING',
        billingCode: 'invalid_signature',
        message: 'origin not in allowlist',
      })
    }

    const driver = await getActiveBillingDriver()
    const signature = this.#signatureHeader(request, driver.name)

    const rawBody = request.raw()
    if (!rawBody) {
      throw new BillingException(
        'webhook_body_unreadable',
        'request body is empty or already consumed before signature verification'
      )
    }

    // The driver verifies the signature and parses; on mismatch it throws a
    // mapped `invalid_signature` BillingException.
    const event = await driver.parseWebhookEvent(rawBody, signature)

    ;(request as HttpRequest & { billingEvent: BillingWebhookEvent }).billingEvent = event
    return next()
  }

  /** Pick the signature header for the active provider. */
  #signatureHeader(request: HttpRequest, provider: string): string | null {
    switch (provider) {
      case 'paddle':
        return request.header('paddle-signature') ?? null
      case 'lemonsqueezy':
        return request.header('x-signature') ?? null
      case 'stripe':
      default:
        return request.header('stripe-signature') ?? null
    }
  }
}
