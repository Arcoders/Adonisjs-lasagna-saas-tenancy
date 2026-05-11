import app from '@adonisjs/core/services/app'
import { HttpRequest } from '@adonisjs/core/http'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import type Stripe from 'stripe'
import { getConfig } from '../config.js'
import BillingException from '../exceptions/billing_exception.js'
import BillingService from '../services/billing_service.js'
import { isStripeWebhookOriginAllowed } from '../services/billing/stripe_ip_allowlist.js'

declare module '@adonisjs/core/http' {
  interface HttpRequest {
    /**
     * The verified Stripe Event attached by `VerifyStripeWebhookMiddleware`.
     * Always present on the webhook controller; throws `E_BILLING` (401) if
     * the signature didn't validate.
     */
    stripeEvent?: Stripe.Event
  }
}

/**
 * Middleware: verify a Stripe webhook signature, attach the parsed event
 * to `request.stripeEvent`. Optional IP allowlist runs first (cheap reject).
 *
 * Why this is class-based: the host wires it as a route middleware, and
 * Adonis 7 expects classes for non-functional middleware (it makes the
 * dependency-injected container call cheaper than a module-level closure).
 *
 * Body access: relies on `request.raw()`, which AdonisJS BodyParser
 * preserves regardless of content-type parsing. Hosts do NOT need to
 * disable bodyparser for the webhook path.
 */
export default class VerifyStripeWebhookMiddleware {
  async handle({ request, response }: HttpContext, next: NextFn) {
    const cfg = getConfig().billing
    if (!cfg) {
      throw new BillingException(
        'config_missing',
        'config.billing not set — cannot verify webhook'
      )
    }

    // 1) Optional IP allowlist (returns true when the feature is off).
    if (!isStripeWebhookOriginAllowed(request.ip())) {
      return response.unauthorized({
        code: 'E_BILLING',
        billingCode: 'invalid_signature',
        message: 'origin not in allowlist',
      })
    }

    // 2) Signature header is mandatory.
    const sig = request.header('stripe-signature')
    if (!sig) {
      throw new BillingException('invalid_signature', 'missing stripe-signature header', {
        status: 400,
      })
    }

    // 3) Raw body. `request.raw()` returns the unparsed body BodyParser
    // preserved internally — Adonis docs guarantee it for any request that
    // went through BodyParser. We don't read from `request.request` (the
    // Node IncomingMessage) directly because by this point its stream has
    // already been consumed.
    const rawBody = request.raw()
    if (!rawBody) {
      throw new BillingException(
        'webhook_body_unreadable',
        'request body is empty or already consumed before signature verification'
      )
    }

    // 4) HMAC verify via the Stripe SDK. Wrapping in a try/catch lets us
    // map StripeSignatureVerificationError onto our stable `invalid_signature`
    // billing code; a generic 500 would leak Stripe's internal error type.
    //
    // Tolerance is passed explicitly (300s, matching Stripe's documented
    // default at the time of writing). Pinning the value here means a
    // future SDK upgrade that loosens the default doesn't silently
    // widen our replay window.
    const billing = await app.container.make(BillingService)
    const stripe = await billing.getClient()
    let event: Stripe.Event
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, cfg.stripe.webhookSecret, 300)
    } catch (err) {
      throw BillingException.fromStripeError(err, 'webhook signature verification failed')
    }

    ;(request as HttpRequest & { stripeEvent: Stripe.Event }).stripeEvent = event
    return next()
  }
}
