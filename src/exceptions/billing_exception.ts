import { Exception } from '@adonisjs/core/exceptions'

/**
 * Stable, user-facing error codes for the billing satellite. Always prefer
 * matching on the `billingCode` rather than the message — messages may be
 * localised or rephrased; codes won't change without a major bump.
 */
export type BillingErrorCode =
  | 'peer_missing'
  | 'config_missing'
  | 'test_in_production'
  | 'live_key_outside_production'
  | 'invalid_signature'
  | 'webhook_body_unreadable'
  | 'customer_not_found'
  | 'tenant_not_resolvable'
  | 'plan_unmapped'
  | 'subscription_not_found'
  | 'card_declined'
  | 'rate_limited'
  | 'api_error'
  | 'network_error'
  | 'metering_failed'
  | 'idempotency_conflict'

/**
 * Wraps Stripe SDK errors and module-level guard failures.
 *
 * Why a dedicated exception:
 *   - Stripe's raw `StripeError.message` can leak internal payment IDs,
 *     test/live mode hints, and request IDs. We never let the host route
 *     those through to the user — `BillingException.message` is always a
 *     short, generic, log-safe string.
 *   - The original Stripe error is preserved in `cause` for structured
 *     logs (with PII redaction applied separately at the log layer).
 */
export default class BillingException extends Exception {
  static readonly status = 400
  static readonly code = 'E_BILLING'

  readonly billingCode: BillingErrorCode
  readonly originalError?: unknown

  constructor(
    billingCode: BillingErrorCode,
    message: string,
    opts?: { status?: number; cause?: unknown }
  ) {
    super(message, { status: opts?.status, code: 'E_BILLING' })
    this.billingCode = billingCode
    this.originalError = opts?.cause
  }

  /**
   * Map a raw Stripe SDK error onto a BillingException. The `type` field
   * Stripe sets on its errors is the discriminator; we map each known type
   * to a billing code + HTTP status the host can pass through to a JSON
   * response without further sanitisation.
   *
   * Unknown types fall through to `api_error` / 500.
   */
  static fromStripeError(err: unknown, fallbackMessage = 'Stripe API error'): BillingException {
    const e = (err ?? {}) as { type?: string; message?: string; code?: string }
    const type = e.type ?? ''

    if (type === 'StripeCardError') {
      return new BillingException('card_declined', 'Card was declined', {
        status: 402,
        cause: err,
      })
    }
    if (type === 'StripeRateLimitError') {
      return new BillingException('rate_limited', 'Stripe API rate limit', {
        status: 429,
        cause: err,
      })
    }
    if (type === 'StripeConnectionError') {
      return new BillingException('network_error', 'Stripe connection error', {
        status: 503,
        cause: err,
      })
    }
    if (type === 'StripeSignatureVerificationError') {
      return new BillingException('invalid_signature', 'Invalid webhook signature', {
        status: 401,
        cause: err,
      })
    }
    if (type === 'StripeIdempotencyError') {
      return new BillingException(
        'idempotency_conflict',
        'Stripe idempotency key reused with different params',
        { status: 409, cause: err }
      )
    }

    return new BillingException('api_error', fallbackMessage, {
      status: 500,
      cause: err,
    })
  }
}
