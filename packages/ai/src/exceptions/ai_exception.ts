import { Exception } from '@adonisjs/core/exceptions'

/**
 * Stable, user-facing error codes for the AI satellite. Always match on the
 * `aiCode` rather than the message; messages may be rephrased, codes will not
 * change without a major bump. The list is a closed union: a new code is a
 * deliberate, reviewed addition, and every switch over it is `assertNever`-guarded.
 */
export const AI_ERROR_CODES = [
  'provider_unavailable',
  'provider_not_allowed',
  'over_budget',
  'rate_limited',
  'rate_limit_unavailable',
  'config_missing',
  'byok_endpoint_blocked',
  'invalid_request',
] as const

export type AIErrorCode = (typeof AI_ERROR_CODES)[number]

/**
 * The HTTP status a pre-flight failure maps to, so a future gateway can set a
 * real status even though the streaming service resolves a `StreamResult` rather
 * than throwing. Pinned by SEAMS.md: over-budget is 402, rate-limited is 429,
 * a Redis outage on the fail-closed reserve and an open breaker are 503.
 */
const STATUS_BY_CODE: Record<AIErrorCode, number> = {
  provider_unavailable: 503,
  provider_not_allowed: 403,
  over_budget: 402,
  rate_limited: 429,
  rate_limit_unavailable: 503,
  config_missing: 500,
  byok_endpoint_blocked: 400,
  invalid_request: 400,
}

/**
 * Whether a code is a transient condition worth retrying (retryable) or a fatal
 * one where retrying wastes compute (fatal). Fatal: config / allow-list / budget
 * / BYOK-endpoint rejections. Retryable: provider-down, rate-limited, and a
 * transient rate-limit-backend outage.
 */
const FATAL_CODES: ReadonlySet<AIErrorCode> = new Set<AIErrorCode>([
  'provider_not_allowed',
  'over_budget',
  'config_missing',
  'byok_endpoint_blocked',
  'invalid_request',
])

/**
 * The satellite's error type. It never carries an upstream provider body, key
 * fragment, prompt or response text: `message` is always a short, log-safe
 * string, so routing it to a client or a log cannot leak a secret (I6 / G9). A
 * raw cause may be attached for structured logs, redacted at the log layer.
 */
export default class AIException extends Exception {
  static readonly status = 400
  static readonly code = 'E_AI'

  readonly aiCode: AIErrorCode
  readonly originalError?: unknown

  constructor(aiCode: AIErrorCode, message: string, opts?: { cause?: unknown }) {
    super(message, { status: STATUS_BY_CODE[aiCode], code: 'E_AI' })
    this.aiCode = aiCode
    this.originalError = opts?.cause
  }

  /** The pinned HTTP status for this code (402 / 429 / 503 / ...). */
  get httpStatus(): number {
    return STATUS_BY_CODE[this.aiCode]
  }

  /** Whether retrying is worthwhile (transient) or a waste (fatal). */
  isRetryable(): boolean {
    return !FATAL_CODES.has(this.aiCode)
  }
}
