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
  | 'invalid_price'
  | 'currency_mismatch'
  | 'subscription_not_found'
  | 'card_declined'
  | 'rate_limited'
  | 'api_error'
  | 'network_error'
  | 'metering_failed'
  | 'idempotency_conflict'
  | 'queue_unavailable'
  | 'authentication_failed'
  | 'invalid_stripe_request'
  | 'permission_denied'
  | 'unsupported_by_driver'

/**
 * Whether a given error code represents a transient condition that
 * may succeed on retry (true) or a fatal one where retrying is a
 * waste of compute and tail-latency (false).
 *
 * Used by `ProcessBillingEventJob` to short-circuit BullMQ retries on
 * fatal errors — a revoked API key or a deleted provider customer
 * isn't going to fix itself in 30s.
 *
 * Fatal:
 *   - config / boot guards (peer_missing, config_missing, env-mode mismatches)
 *   - signature / body integrity (invalid_signature, webhook_body_unreadable)
 *   - resource not found / known to be wrong (subscription_not_found,
 *     plan_unmapped, invalid_price, idempotency_conflict, card_declined)
 *   - Stripe-side fatal (authentication_failed, invalid_stripe_request,
 *     permission_denied)
 *
 * Retryable (anything else):
 *   - network / rate / 5xx (network_error, rate_limited, api_error,
 *     queue_unavailable, metering_failed)
 *   - resolution races (customer_not_found, tenant_not_resolvable —
 *     a checkout.session.completed may not have been processed yet)
 */
const FATAL_CODES = new Set<BillingErrorCode>([
  'peer_missing',
  'config_missing',
  'test_in_production',
  'live_key_outside_production',
  'invalid_signature',
  'webhook_body_unreadable',
  'plan_unmapped',
  'invalid_price',
  'currency_mismatch',
  'subscription_not_found',
  'card_declined',
  'idempotency_conflict',
  'authentication_failed',
  'invalid_stripe_request',
  'permission_denied',
  'unsupported_by_driver',
])

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
   * Whether this error is worth retrying. Callers (notably the webhook
   * job) should short-circuit fatal errors to skip the queue's retry
   * budget.
   */
  isRetryable(): boolean {
    return !FATAL_CODES.has(this.billingCode)
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
    if (type === 'StripeAuthenticationError') {
      // Revoked / wrong API key. Job retries will all fail the same way.
      return new BillingException(
        'authentication_failed',
        'Stripe API key was rejected — check STRIPE_API_KEY',
        { status: 401, cause: err }
      )
    }
    if (type === 'StripeInvalidRequestError') {
      // Bad parameters, missing required field, deleted resource. Not
      // a transient condition — a retry will fail with the same error.
      return new BillingException(
        'invalid_stripe_request',
        'Stripe rejected the request as invalid',
        { status: 400, cause: err }
      )
    }
    if (type === 'StripePermissionError') {
      // API key doesn't have access to the resource (Stripe Connect).
      return new BillingException(
        'permission_denied',
        'Stripe API key does not have permission for this resource',
        { status: 403, cause: err }
      )
    }

    return new BillingException('api_error', fallbackMessage, {
      status: 500,
      cause: err,
    })
  }
}
