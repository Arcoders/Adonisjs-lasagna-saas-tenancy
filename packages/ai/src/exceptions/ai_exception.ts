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
  // injection defense (Wave 3): a host InjectionClassifier returned a block verdict
  'injection_detected',
  // vector store
  'rowscope_unsupported',
  'dimension_mismatch',
  'embedding_quota_exhausted',
  'tenant_scope_mismatch',
  'vector_store_unavailable',
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
  // tool / function calling (WS-AI-11)
  'tool_unknown',
  'tool_denied',
  'tool_input_invalid',
  'tool_action_disabled',
  'tool_budget_exhausted',
  'too_many_concurrent',
  // Action-tool confirmation (WS-AI-11 Phase 3a)
  'tool_confirmation_required',
  'tool_confirmation_invalid',
  'tool_action_unavailable',
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
  // A host injection classifier's block verdict is a permanent client fault, like
  // invalid_request: the forged/manipulated input is a 400, not a retryable outage.
  injection_detected: 400,
  // vector store: a rowscope tenant / a dimension mismatch / a malformed
  // request are permanent 4xx; over the storage cap is 402 (like over_budget); a
  // tenant-scope-seal breach is a 500 (an internal invariant, never a client fault).
  rowscope_unsupported: 400,
  dimension_mismatch: 400,
  embedding_quota_exhausted: 402,
  tenant_scope_mismatch: 500,
  // A vector-store backend outage (the pg connection died mid-query) is a transient
  // 503, like the reserve rail's rate_limit_unavailable: nothing is wrong with the
  // request, retrying once the database recovers is exactly right.
  vector_store_unavailable: 503,
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
  // Tool-calling refusals: an unknown tool or invalid model-generated arguments
  // are permanent 400s; a denied authorization and a disabled action tool are
  // 403s like the other authz gates. The loop ceiling is 402 like over_budget (a
  // spend cap), and too many concurrent tool loops for one tenant is a 429.
  tool_unknown: 400,
  tool_denied: 403,
  tool_input_invalid: 400,
  tool_action_disabled: 403,
  tool_budget_exhausted: 402,
  too_many_concurrent: 429,
  // A presented confirmation that does not authorize the action is a 403: the
  // client sent a credential and it does not grant this. Distinct from sending
  // none, which is not an error at all but a fresh challenge. The ledger being
  // unreachable is a 503: nothing is wrong with the request, we just cannot
  // promise the effect happens only once, so we decline to make it.
  // 428: the request is well-formed and permitted, it is just missing the one
  // precondition that matters, a human agreeing. The client's move is to show the
  // confirmation and re-send with the token, not to fix the request.
  tool_confirmation_required: 428,
  tool_confirmation_invalid: 403,
  tool_action_unavailable: 503,
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
 * Whether a code is a transient condition worth retrying (`'retryable'`) or a
 * fatal one where retrying wastes compute (`'fatal'`). Unlike the hand-maintained
 * `Set` this replaced, it is a `Record<AIErrorCode, ...>` total over the code
 * union exactly like {@link STATUS_BY_CODE}: adding a code without classifying its
 * retryability is now a compile error, not a silent default-to-retryable. That
 * closes the one footgun the old design documented in-line, where the two adjacent
 * confirmation codes classify OPPOSITELY: `tool_confirmation_invalid` /
 * `tool_confirmation_required` are `'fatal'` (a forged or missing confirmation does
 * not become valid by re-sending the identical request), while
 * `tool_action_unavailable` is `'retryable'` (the ledger is down, nothing about the
 * request is wrong, retry once it recovers). `'fatal'` also covers config /
 * allow-list / budget / BYOK-endpoint / vector-store / scope / tool refusals.
 * `'retryable'` covers provider-down, rate-limited, a transient rate-limit-backend
 * outage, and an audit-DB write blip.
 */
const RETRYABILITY: Record<AIErrorCode, 'fatal' | 'retryable'> = {
  provider_unavailable: 'retryable',
  provider_not_allowed: 'fatal',
  over_budget: 'fatal',
  rate_limited: 'retryable',
  rate_limit_unavailable: 'retryable',
  config_missing: 'fatal',
  byok_endpoint_blocked: 'fatal',
  invalid_request: 'fatal',
  // A blocked request never becomes correct on a retry of the IDENTICAL input, so a
  // block verdict is fatal (retrying the same manipulated prompt must be refused).
  injection_detected: 'fatal',
  // The vector-store codes never become correct on a retry: a rowscope host cannot
  // use the vector store, a dimension mismatch is a config fault, the storage cap is
  // a plan limit, a scope-seal breach is a bug. A backend outage is a SEPARATE code
  // (`vector_store_unavailable`), which is retryable.
  rowscope_unsupported: 'fatal',
  dimension_mismatch: 'fatal',
  embedding_quota_exhausted: 'fatal',
  tenant_scope_mismatch: 'fatal',
  // A backend outage is the one vector-store code that IS worth retrying (the query
  // will succeed once the database is back), unlike the four permanent ones above.
  vector_store_unavailable: 'retryable',
  // A blocked/unfetchable document URL and a denied ingestion are both permanent.
  doc_fetch_blocked: 'fatal',
  ingestion_denied: 'fatal',
  // A denied retrieval authorizer is permanent, not retryable.
  retrieval_denied: 'fatal',
  // An audit row that cannot be written is a fail-closed 503 whose cause is usually
  // a transient audit-DB outage, so retrying is right.
  audit_write_failed: 'retryable',
  // A forged/malformed session token will not become valid on a retry.
  memory_session_invalid: 'fatal',
  // A residency denial is a permanent policy refusal (a client would otherwise retry
  // the very egress residency exists to block).
  residency_denied: 'fatal',
  // An unknown tool, a denied authorization, invalid model arguments and a disabled
  // action tool are all permanent refusals: the same request re-run is refused
  // identically. The tool-loop ceiling is deterministic too. The per-tenant
  // concurrency cap is fatal on purpose (anti-flood): a client must back off, not
  // hammer retries that would worsen the very flood it defends.
  tool_unknown: 'fatal',
  tool_denied: 'fatal',
  tool_input_invalid: 'fatal',
  tool_action_disabled: 'fatal',
  tool_budget_exhausted: 'fatal',
  too_many_concurrent: 'fatal',
  // Re-sending the IDENTICAL request cannot help: it will lack a confirmation again.
  // The client's next move is a different request carrying the token.
  tool_confirmation_required: 'fatal',
  // A presented confirmation that does not authorize the action never will: forged,
  // expired, or minted for a different tenant/user/tool/arguments. Making it read as
  // retryable would invite a client to hammer the MAC on a mutation path.
  tool_confirmation_invalid: 'fatal',
  // The opposite of the two above: the ledger is unreachable, the request is fine,
  // retrying once it recovers is exactly right.
  tool_action_unavailable: 'retryable',
}

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
    return RETRYABILITY[this.aiCode] === 'retryable'
  }
}
