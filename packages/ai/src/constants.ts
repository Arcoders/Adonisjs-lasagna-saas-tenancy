/**
 * Package-level defaults for the AI satellite. Everything the streaming spine
 * treats as tunable lives here as a named constant with a sane default, so no
 * value is inlined at a call site and a host can override it through
 * `config.ai`. Provider-specific defaults (base URLs, models, the Anthropic
 * version header) live next to their providers, not here.
 */

/** The built-in provider selected when a tenant does not choose one. */
export const DEFAULT_AI_PROVIDER = 'claude'

/**
 * SSE heartbeat interval. A comment frame is written this often to hold the
 * connection open and surface a dead socket fast. It must stay below any
 * upstream proxy idle timeout (nginx / ALB around 60s, Cloudflare around 100s);
 * see the production checklist. Tunable via `config.ai.heartbeatMs`.
 */
export const DEFAULT_HEARTBEAT_MS = 15_000

/**
 * Default per-request output token cap when neither the request nor
 * `config.ai.maxTokens` names one. Becomes the quota reservation's worst case,
 * so it is deliberately conservative. Tunable via `config.ai.maxTokens`.
 */
export const DEFAULT_AI_MAX_TOKENS = 1024

/**
 * Default replay window for a completed response under its `Idempotency-Key`.
 * Short on purpose: the cache absorbs client retries, it is not a response
 * store. Tunable via `config.ai.idempotencyTtlMs`.
 */
export const DEFAULT_AI_IDEMPOTENCY_TTL_MS = 60_000

/**
 * Default bound on one request's combined message content length, in
 * characters. Rejected with a 400 before any reservation or provider call.
 * Tunable via `config.ai.maxPromptChars`.
 */
export const DEFAULT_AI_MAX_PROMPT_CHARS = 32_000

/**
 * Hard cap on the bytes of one cached idempotent response. A completed stream
 * over the cap simply is not cached (the stream itself is never aborted for
 * cache reasons). Not host-tunable: the cap protects the shared cache backend.
 */
export const AI_IDEMPOTENCY_MAX_BYTES = 262_144

/**
 * Hard bound on the `Idempotency-Key` header length. A longer (or empty, or
 * non-printable) key is a malformed request, rejected with a 400. Not
 * host-tunable: the bound protects the key-derivation input.
 */
export const AI_IDEMPOTENCY_KEY_MAX_LENGTH = 200
