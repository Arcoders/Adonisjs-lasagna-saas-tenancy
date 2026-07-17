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
 * Hard per-fragment size bound for the interim output gate (the byte-cap slice
 * of the output bound; semantic output validation is a retrieval-layer concern).
 * A single fragment over the bound aborts the stream as `fragment_rejected`
 * without writing the bytes.
 */
export const AI_FRAGMENT_MAX_CHARS = 16_384

/**
 * Per-tenant counter of chat output fragments a host `config.ai.redactOutput`
 * hook changed or aborted. Content-free (a count, never the text): it makes the
 * host's optional output-redaction policy observable. Redaction is host-owned
 * defense-in-depth, never the isolation control (tenant isolation and the output
 * bound remain the guarantee).
 */
export const AI_OUTPUT_REDACTED_METRIC = 'ai_output_redacted'

/**
 * The per-tenant embeddings table backing the vector store. A fixed module
 * constant, never a `tenant_<id>`-interpolated name: the row lives in whatever
 * schema/database the active isolation driver reports via `tableLocation(tenant)`,
 * and the bare table name resolves there through the tenant connection's
 * search_path. Used in both the migration DDL and the vector store's
 * parameterized raw SQL.
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
 * Conversation memory. The Redis key prefix for a session's turn
 * list. The full key is `ai:mem:<tenantId>:<userMac>:<sessionMac>`: the tenant
 * segment scopes a purge, the userMac segment scopes a per-user (GDPR) erasure,
 * and the sessionMac addresses one conversation. Fixed constant, never inlined.
 */
export const AI_MEMORY_KEY_PREFIX = 'ai:mem'

/**
 * The enc_v2 secret class for conversation memory. Maps to its own HKDF context
 * (`ai:conversation-memory:v1`) in the kernel's `SECRET_CLASS`, so a memory blob
 * cannot be decrypted as any other secret class (confused-deputy resistance).
 */
export const AI_MEMORY_SECRET_CLASS = 'aiConversationMemory'

/**
 * Default number of prior exchanges (one user+assistant pair each) replayed into
 * a chat context. Older exchanges are dropped (LTRIM) so the list stays bounded.
 * Tunable via `config.ai.memory.maxTurns`.
 */
export const DEFAULT_MEMORY_MAX_TURNS = 20

/**
 * Default character budget for the replayed memory block. Memory is injected
 * AFTER retrieval with `min(this, maxPromptChars - assembledChars)`, so the
 * assembled prompt never exceeds `maxPromptChars` (#2/#8). Tunable via
 * `config.ai.memory.maxChars`.
 */
export const DEFAULT_MEMORY_MAX_CHARS = 8_000

/**
 * Default sliding TTL for a session's memory, in ms (24h). Refreshed (PEXPIRE)
 * on every append, so an active conversation persists and an abandoned one
 * expires. An APP_KEY rotation bounds unreadable memory to this window. Tunable
 * via `config.ai.memory.ttlMs`.
 */
export const DEFAULT_MEMORY_TTL_MS = 86_400_000

/**
 * The append-only AI audit table. A fixed module constant living in
 * the shared `backoffice` schema, so it survives `tenant:purge-expired` (which
 * drops the tenant schema) and the tenant request role cannot DROP it. Used both
 * in the published migration DDL and the writer's schema-qualified raw SQL, always
 * as `backoffice.ai_audit_logs`.
 */
export const AI_AUDIT_TABLE = 'ai_audit_logs'

/**
 * The action-tool at-most-once ledger (WS-AI-11 Phase 3a). Shares the `backoffice`
 * schema with the audit table for the same reasons, but is deliberately NOT
 * append-only: a claimed row is updated once when its effect settles, so the
 * triggers guarding the audit chain would be wrong on it. The audit row is the
 * evidence that an action happened; this row is the fence that stops it happening
 * twice.
 */
export const AI_ACTION_LEDGER_TABLE = 'ai_action_ledger'

/**
 * Advisory-lock key prefix for the per-tenant audit hash chain. Each `append`
 * takes `pg_advisory_xact_lock(hashtext('ai_audit:'||tenant_id))` so a tenant's
 * `seq`+`checksum` links are serialized (released at commit); different tenants
 * never contend. Mirrors the embeddings-cap lock idiom.
 */
export const AI_AUDIT_LOCK_PREFIX = 'ai_audit:'

/**
 * Per-destination deadline for external audit anchoring (#6). After the
 * canonical row commits, each row is fanned out best-effort to the host's audit
 * destinations (the kernel `AuditLogDestinationRegistry`); a slow or throwing
 * destination is bounded and isolated, never affecting the committed row or the
 * request. Matches the kernel's `DESTINATION_TIMEOUT_MS`.
 */
export const AI_AUDIT_ANCHOR_TIMEOUT_MS = 2_000

// --- Tool / function calling (WS-AI-11) ---
// The tool loop's ceilings. Each DEFAULT_* is `config.ai.tools.*`-overridable and
// clamped to its MAX_* hard cap; a value at a call site is always one of these.

/**
 * Default number of provider rounds one tool loop may run (a round is one model
 * turn plus its tool executions). The loop stops when the model answers without
 * calling a tool, and trips `tool_budget_exhausted` if it is still calling at the
 * ceiling. Tunable via `config.ai.tools.maxRounds`, clamped to {@link MAX_AI_TOOL_ROUNDS}.
 */
export const DEFAULT_AI_MAX_TOOL_ROUNDS = 4

/** Hard ceiling on the tool-loop round count, regardless of config. */
export const MAX_AI_TOOL_ROUNDS = 8

/**
 * Default cap on tool calls executed in a single round. A round that asks for
 * more executes the first N and logs the drop (never a silent cap). Tunable via
 * `config.ai.tools.maxToolsPerRound`, clamped to {@link MAX_TOOLS_PER_ROUND}.
 */
export const DEFAULT_MAX_TOOLS_PER_ROUND = 4

/** Hard ceiling on tool calls per round, regardless of config. */
export const MAX_TOOLS_PER_ROUND = 8

/**
 * Hard cap on total tool calls across all rounds of one request (a second stop
 * beside `maxRounds`). Config may lower it but never raise it above this ceiling.
 */
export const MAX_TOOL_CALLS_PER_REQUEST = 16

/**
 * Default cap on a tenant's TOTAL concurrent in-flight AI streams, evaluated when
 * a tool loop tries to start (Phase 2a). A tool-loop request is admitted only
 * while the tenant's live stream count is below this; at or above it the loop is
 * refused pre-commit with a 429 `too_many_concurrent`, so a flood of expensive
 * multi-round loops cannot starve the tenant's connection pool or drain its
 * wallet. The count is a conservative superset: plain chat / embed / retrieve
 * acquire uncapped and count toward it but are never themselves refused. Named
 * for its purpose (bounding tool-loop concurrency) though it gates on total
 * in-flight. Per-process / per-pod, matching the liveness-abort posture. Tunable
 * via `config.ai.tools.maxConcurrentPerTenant`, clamped to
 * {@link MAX_CONCURRENT_TOOL_LOOPS_PER_TENANT}.
 */
export const DEFAULT_MAX_CONCURRENT_TOOL_LOOPS_PER_TENANT = 8

/** Hard ceiling on concurrent tool loops per tenant, regardless of config. */
export const MAX_CONCURRENT_TOOL_LOOPS_PER_TENANT = 32

/**
 * Default per-tool execution deadline in ms. The handler runs under a signal that
 * aborts at this deadline (composed with the request signal), so one slow tool
 * cannot stall the loop past it. Tunable via `config.ai.tools.toolTimeoutMs`,
 * clamped to {@link MAX_TOOL_TIMEOUT_MS}.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 5_000

/** Hard ceiling on a per-tool timeout, regardless of config. */
export const MAX_TOOL_TIMEOUT_MS = 30_000

/**
 * Default cap on the characters of a fenced tool result re-injected as a
 * `role: 'tool'` turn. A longer result is truncated (never streamed raw), so a
 * hostile or verbose tool cannot blow the prompt budget. Tunable via
 * `config.ai.tools.maxToolResultChars`, clamped to {@link MAX_TOOL_RESULT_CHARS}.
 */
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 4_000

/** Hard ceiling on a tool result's characters, regardless of config. */
export const MAX_TOOL_RESULT_CHARS = 16_000

/**
 * Default cap on the raw `arguments` JSON text of one tool call, enforced BEFORE
 * `JSON.parse` so an adversarial mega-payload is rejected before it is parsed.
 * Tunable via `config.ai.tools.maxToolArgsChars`, clamped to {@link MAX_TOOL_ARGS_CHARS}.
 */
export const DEFAULT_MAX_TOOL_ARGS_CHARS = 8_000

/** Hard ceiling on a tool call's raw argument characters, regardless of config. */
export const MAX_TOOL_ARGS_CHARS = 16_000

/** Hard cap on the number of tools advertised to the model in one request. Not host-tunable. */
export const MAX_TOOL_DEFS = 64

/**
 * The fence tag wrapping a tool result re-injected into the model context. A tool
 * result is untrusted data (it could carry indirect prompt injection), so it is
 * fenced in a `role: 'tool'` turn and any occurrence of this token inside the
 * result is neutralized, exactly like the retrieved-context fence. Fixed constant,
 * never inlined.
 */
export const AI_TOOL_FENCE_TAG = 'tool_result'

/**
 * Per-tenant integer metric names for tool calling (WS-AI-11), emitted best-effort
 * through the executor's / loop's `emitMetric` seam (never on the reject path). Guard
 * trips already bridge `ai_guard_rejections`; these give per-outcome and latency
 * visibility. Fixed names, never inlined.
 */
export const AI_TOOL_CALLS_METRIC = 'ai_tool_calls'
export const AI_TOOL_ERRORS_METRIC = 'ai_tool_errors'
export const AI_TOOL_DENIALS_METRIC = 'ai_tool_denied'
export const AI_TOOL_BUDGET_EXHAUSTED_METRIC = 'ai_tool_budget_exhausted'
export const AI_TOOL_LATENCY_METRIC = 'ai_tool_latency_ms'

/**
 * How long a minted action-tool confirmation stays spendable (WS-AI-11 Phase 3a).
 * Short on purpose: the token is a bearer capability for one mutation, and it
 * cannot be revoked, so its lifetime IS its revocation. Long enough for a human to
 * read a prompt and decide, not long enough to be worth capturing from a log.
 */
export const TOOL_CONFIRMATION_TTL_MS = 300_000

/**
 * How long the action ledger remembers that one confirmation already fired.
 *
 * MUST be >= {@link TOOL_CONFIRMATION_TTL_MS}: the record has to outlive the token
 * that could re-present it, or a replay arriving late finds no record and fires the
 * effect a second time. An architectural spec pins the relationship, because it is
 * exactly the kind of constraint that rots silently when someone tunes one number.
 *
 * One TTL, deliberately, with no in-flight/settled split: a shorter in-flight window
 * would reopen an at-least-once gap on the settle-failure path the ledger exists to
 * close.
 */
export const TOOL_ACTION_LEDGER_TTL_MS = 900_000

/**
 * The kernel `SECRET_CLASS` this package's confirmation MAC key is derived under
 * (`ai:tool-confirmation:v1`), so a leaked key is attributable to one domain and
 * rotating it cannot silently widen to another.
 */
export const AI_TOOL_CONFIRMATION_SECRET_CLASS = 'aiToolConfirmation'

/**
 * The header carrying spent confirmation tokens. A header, not a body field, so the
 * `parseChatBody` grammar (the structural closure that stops a client forging a tool
 * turn) stays untouched; `Idempotency-Key` is the precedent for effect-control
 * metadata riding beside the body. HONEST COST, documented for hosts: headers reach
 * access logs, proxies and APM by default. The short TTL and the principal binding
 * bound the damage; they do not remove it. Scrub this header.
 */
export const AI_TOOL_CONFIRMATION_HEADER = 'x-ai-tool-confirmation'

/** Version prefix on a minted token, so a format change is detectable, never ambiguous. */
export const AI_TOOL_CONFIRMATION_TOKEN_PREFIX = 'aitc1'

/** Bound on one presented token, checked before any parsing or MAC work. */
export const AI_TOOL_CONFIRMATION_TOKEN_MAX_LENGTH = 256

/**
 * Max tokens accepted on one request. Equals {@link MAX_TOOLS_PER_ROUND}: a round
 * can never need more confirmations than it is allowed tool calls, so anything more
 * is a client bug or someone spraying tokens at the MAC.
 */
export const MAX_TOOL_CONFIRMATIONS_PER_REQUEST = MAX_TOOLS_PER_ROUND

/** Bound on the host-authored argument summary a human reads before confirming. */
export const AI_TOOL_ARGS_SUMMARY_MAX_CHARS = 500

/** Depth bound while canonicalizing arguments for hashing (a cyclic or deep object must not hang the pump). */
export const AI_TOOL_ARGS_CANONICAL_MAX_DEPTH = 8

/**
 * Per-tenant integer metrics for the Phase 3a confirmation flow.
 *
 * `ai_tool_confirmation_unmatched` earns its place: a token was PRESENTED and did
 * not verify, which is deliberately NOT a guard trip (the model rephrasing a number
 * would page an operator at 3am for working as designed). Without this counter,
 * "our redactOutput regex ate every token" and "the model re-proposed different
 * arguments" are the same silent signal forever.
 */
export const AI_TOOL_CONFIRMATION_REQUIRED_METRIC = 'ai_tool_confirmation_required'
export const AI_TOOL_CONFIRMATION_UNMATCHED_METRIC = 'ai_tool_confirmation_unmatched'
export const AI_TOOL_ACTION_EXECUTED_METRIC = 'ai_tool_action_executed'
export const AI_TOOL_ACTION_REPLAYED_METRIC = 'ai_tool_action_replayed'
