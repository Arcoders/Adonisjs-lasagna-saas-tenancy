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

/**
 * The quota key the chat gateway reserves against. Colon-free camelCase like
 * the kernel's plan quota names (`apiCallsPerDay`); hosts wire the per-plan
 * budget and the operator ceiling under this name in `config.plans`.
 */
export const AI_TOKENS_QUOTA = 'aiTokens'

/**
 * Hard per-fragment size bound for the interim output gate (I8's byte-cap
 * slice; semantic output validation is WS-AI-5). A single fragment over the
 * bound aborts the stream as `fragment_rejected` without writing the bytes.
 */
export const AI_FRAGMENT_MAX_CHARS = 16_384

/**
 * The per-tenant embeddings table (WS-AI-3, I1). A fixed module constant, never
 * a `tenant_<id>`-interpolated name: the row lives in whatever schema/database
 * the active isolation driver reports via `tableLocation(tenant)`, and the bare
 * table name resolves there through the tenant connection's search_path. Used in
 * both the migration DDL and the vector store's parameterized raw SQL.
 */
export const AI_EMBEDDINGS_TABLE = 'ai_embeddings'

/**
 * Default embedding vector dimension when `config.ai.embedding.dimension` is
 * unset. 1536 matches the common OpenAI-compatible small-embedding models. It is
 * baked into the `vector(N)` column at migrate time, so changing it after data
 * exists needs a new migration; pgvector's hnsw index caps N at 2000.
 */
export const DEFAULT_EMBEDDING_DIM = 1536

/**
 * The exhaustion quota (#18) bounding how many embedding rows a tenant may store,
 * checked against the per-plan `limits.embeddingCount` (Infinity when unset). A
 * durable gauge counted from the table itself, never a rolling-day `consume`
 * counter (which resets at midnight).
 */
export const EMBEDDING_COUNT_QUOTA = 'embeddingCount'

/** Default per-request worst-case output-token estimate per embedded chunk, reserved against `aiTokens`. */
export const DEFAULT_MAX_EMBEDDING_TOKENS_PER_CHUNK = 512

/** Max pgvector-indexable dimension (hnsw / ivfflat hard limit). Config is validated against it. */
export const MAX_EMBEDDING_DIM = 2000

/**
 * Default cap on the bytes of a document fetched by `sourceUrl` through the
 * SSRF-pinned fetch, before it is embedded. Bounds a hostile or accidental
 * huge-document ingest. Tunable via `config.ai.embedding.ingestionMaxBytes`.
 */
export const DEFAULT_INGESTION_MAX_BYTES = 1_048_576
