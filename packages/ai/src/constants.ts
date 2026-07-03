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
 * SSRF-pinned fetch, before it is embedded. The transfer is streamed and aborted
 * the moment the running byte total crosses this cap (it never buffers the whole
 * body first), so a hostile public host that passes the IP-pin cannot OOM the
 * worker with a multi-GB body. Tunable via `config.ai.embedding.ingestionMaxBytes`.
 */
export const DEFAULT_INGESTION_MAX_BYTES = 1_048_576

/**
 * Default request deadline for a `sourceUrl` document fetch, in ms. A slow or
 * hung upstream (one that passes the SSRF pin but trickles bytes) is aborted at
 * this deadline instead of pinning an ingest worker for the whole client
 * connection. Tunable via `config.ai.embedding.ingestionTimeoutMs`.
 */
export const DEFAULT_INGESTION_TIMEOUT_MS = 10_000

/** Default max characters per input chunk. A longer chunk is a 400 before any cost. Tunable via `config.ai.embedding.maxChunkChars`. */
export const DEFAULT_MAX_CHUNK_CHARS = 8_000

/** Default max chunks per ingest request. Tunable via `config.ai.embedding.maxBatchChunks`. */
export const DEFAULT_MAX_BATCH_CHUNKS = 64

/** Default max serialized bytes of a chunk's `metadata`. Tunable via `config.ai.embedding.maxMetadataBytes`. */
export const DEFAULT_MAX_METADATA_BYTES = 4_096

/** Hard bound on the `source` key length. Not host-tunable. */
export const AI_SOURCE_MAX_CHARS = 512

/** Default number of nearest matches a retrieval returns when a request omits one. Tunable via `config.ai.retrieval.defaultLimit`. */
export const DEFAULT_RETRIEVAL_LIMIT = 8

/** Hard cap on the matches one retrieval request may ask for. Tunable via `config.ai.retrieval.maxLimit`. */
export const MAX_RETRIEVAL_LIMIT = 50

/** Default max characters of a retrieval query. A longer query is a 400 before any cost. Tunable via `config.ai.retrieval.maxQueryChars`. */
export const DEFAULT_MAX_QUERY_CHARS = 4_000

/**
 * Default max retrieved documents folded into one chat context block (#8 output
 * bounds). Retrieved content is untrusted data, so the block is bounded before
 * it enters a prompt. Tunable via `config.ai.retrieval.maxContextItems`.
 */
export const DEFAULT_MAX_CONTEXT_ITEMS = 8

/**
 * Default max characters of the fenced retrieved context block injected into a
 * chat prompt (#8). The block is trimmed (lowest-ranked matches dropped first)
 * so the ASSEMBLED prompt never exceeds `maxPromptChars`. Tunable via
 * `config.ai.retrieval.maxContextChars`.
 */
export const DEFAULT_MAX_CONTEXT_CHARS = 8_000

/**
 * The append-only AI audit table (WS-AI-7, I5). A fixed module constant living in
 * the shared `backoffice` schema, so it survives `tenant:purge-expired` (which
 * drops the tenant schema) and the tenant request role cannot DROP it. Used both
 * in the published migration DDL and the writer's schema-qualified raw SQL, always
 * as `backoffice.ai_audit_logs`.
 */
export const AI_AUDIT_TABLE = 'ai_audit_logs'

/**
 * Advisory-lock key prefix for the per-tenant audit hash chain. Each `append`
 * takes `pg_advisory_xact_lock(hashtext('ai_audit:'||tenant_id))` so a tenant's
 * `seq`+`checksum` links are serialized (released at commit); different tenants
 * never contend. Mirrors the embeddings-cap lock idiom.
 */
export const AI_AUDIT_LOCK_PREFIX = 'ai_audit:'

/**
 * Per-destination deadline for external audit anchoring (WS-AI-7, #6). After the
 * canonical row commits, each row is fanned out best-effort to the host's audit
 * destinations (the kernel `AuditLogDestinationRegistry`); a slow or throwing
 * destination is bounded and isolated, never affecting the committed row or the
 * request. Matches the kernel's `DESTINATION_TIMEOUT_MS`.
 */
export const AI_AUDIT_ANCHOR_TIMEOUT_MS = 2_000
