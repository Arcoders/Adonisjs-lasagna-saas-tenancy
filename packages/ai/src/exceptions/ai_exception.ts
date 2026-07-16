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
  // vector store
  'rowscope_unsupported',
  'dimension_mismatch',
  'embedding_quota_exhausted',
  'tenant_scope_mismatch',
  // ingestion
  'doc_fetch_blocked',
  'ingestion_denied',
  // retrieval
  'retrieval_denied',
  // audit
  'audit_write_failed',
  // memory
  'memory_session_invalid',
  // compliance / residency
  'residency_denied',
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
  // vector store: a rowscope tenant / a dimension mismatch / a malformed
  // request are permanent 4xx; over the storage cap is 402 (like over_budget); a
  // tenant-scope-seal breach is a 500 (an internal invariant, never a client fault).
  rowscope_unsupported: 400,
  dimension_mismatch: 400,
  embedding_quota_exhausted: 402,
  tenant_scope_mismatch: 500,
  // A document URL the SSRF pin blocked (or could not fetch) is a 400; a denied
  // ingestion authorizer is a 403, like the access gate.
  doc_fetch_blocked: 400,
  ingestion_denied: 403,
  // A denied retrievalFilter (the per-user document ACL) is a 403, like the
  // access and ingestion gates.
  retrieval_denied: 403,
  // An audit row that cannot be written is a fail-closed 503 (the action must
  // be attributable, and the failure is usually a transient audit-DB outage).
  audit_write_failed: 503,
  // A conversation-memory session token that does not verify is a malformed /
  // forged request (like a malformed Idempotency-Key), a permanent 400.
  memory_session_invalid: 400,
  // A request whose provider/embedding egress is not allowed by the tenant's
  // residency posture (#7/#15) is a permanent 403, like the other authz gates.
  residency_denied: 403,
}

/**
 * The pinned HTTP status for an AI error code. This is the single source of
 * truth for status mapping: the gateway resolves a pre-flight failure to a
 * status through here rather than a parallel hand-maintained table, so a fatal
 * typed refusal thrown before the first byte (provider_not_allowed stays 403,
 * byok_endpoint_blocked stays 400) keeps its own status instead of drifting into a
 * retryable 503. Total over `AIErrorCode` by construction.
 */
export function httpStatusForAiCode(code: AIErrorCode): number {
  return STATUS_BY_CODE[code]
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
  // The vector-store codes never become correct on a retry: a rowscope host cannot use
  // the vector store, a dimension mismatch is a config fault, the storage cap is a
  // plan limit, and a scope-seal breach is a bug.
  'rowscope_unsupported',
  'dimension_mismatch',
  'embedding_quota_exhausted',
  'tenant_scope_mismatch',
  // A blocked/unfetchable document URL and a denied ingestion are both permanent.
  'doc_fetch_blocked',
  'ingestion_denied',
  // A denied retrieval authorizer is permanent, not retryable.
  'retrieval_denied',
  // A forged/malformed session token will not become valid on a retry.
  'memory_session_invalid',
  // FATAL_CODES is a plain Set (NOT compile-forced by the union), so this entry is
  // added by hand. A residency denial is a permanent policy refusal, and a missing
  // entry here would wrongly make it retryable (a client would retry the very egress
  // residency exists to block).
  'residency_denied',
])

/**
 * The satellite's error type. It never carries an upstream provider body, key
 * fragment, prompt or response text: `message` is always a short, log-safe
 * string, so routing it to a client or a log cannot leak a secret. A
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
