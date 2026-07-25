/**
 * Package-level defaults for the AI satellite. Everything the streaming spine
 * treats as tunable lives here as a named constant with a sane default, so no
 * value is inlined at a call site and a host can override it through
 * `config.ai`. Provider-specific defaults (base URLs, models, the Anthropic
 * version header) live next to their providers, not here.
 */

// A type-only import: erased at build, so this module never value-imports the
// eager core `/services` barrel.
import type { FailurePolicy } from '@adonisjs-lasagna/saas-tenancy/services'

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

// --- Injection defense ---
// The structural boundary (fence/delimiter neutralization + role separation) is
// made OBSERVABLE, and a pluggable `InjectionClassifier` host seam runs on INPUT.
// The metric names below are fixed, content-free per-tenant counters, never inlined.

/**
 * Per-tenant counter of retrieved-document / tool-result fence-token forgeries the
 * structural boundary NEUTRALIZED (LLM01). Content-free (a count,
 * never the token or the document): it makes the already-closed structural defense
 * observable so an operator can watch a corpus probing for a fence breakout by its
 * rate. Mirrors {@link AI_OUTPUT_REDACTED_METRIC}: a dedicated counter beside the
 * shared `ai_guard_rejections` bridge, because a neutralize-and-observe signal is
 * not a rejection and must not inflate the reject counter.
 */
export const AI_INJECTION_STRUCTURAL_METRIC = 'ai_injection_structural'

/**
 * Per-tenant counter of requests a host `config.ai.injection.classifier` BLOCKED.
 * Content-free: it makes the optional semantic detector's block rate
 * observable so false positives are the operator's tuning signal, never the text.
 */
export const AI_INJECTION_DETECTED_METRIC = 'ai_injection_detected'

/**
 * Per-tenant counter of times a host injection classifier itself failed (threw or
 * returned a malformed verdict). The classifier is NOT the isolation boundary
 * (structural role separation plus a tenant-pure context is), so its error is fail-OPEN by default and
 * this counter is how that accepted degradation stays visible; a host that sets
 * `onError: 'closed'` couples availability to the detector knowingly.
 */
export const AI_INJECTION_DETECTOR_ERROR_METRIC = 'ai_injection_detector_error'

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
 * The exhaustion quota bounding how many embedding rows a tenant may store,
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
 * Default max retrieved documents folded into one chat context block, one of the
 * output bounds. Retrieved content is untrusted data, so the block is bounded before
 * it enters a prompt. Tunable via `config.ai.retrieval.maxContextItems`.
 */
export const DEFAULT_MAX_CONTEXT_ITEMS = 8

/**
 * Default max characters of the fenced retrieved context block injected into a
 * chat prompt. The block is trimmed (lowest-ranked matches dropped first)
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
 * assembled prompt never exceeds `maxPromptChars`. Tunable via
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
 * The action-tool at-most-once ledger. Shares the `backoffice`
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
 * Per-destination deadline for external audit anchoring. After the
 * canonical row commits, each row is fanned out best-effort to the host's audit
 * destinations (the kernel `AuditLogDestinationRegistry`); a slow or throwing
 * destination is bounded and isolated, never affecting the committed row or the
 * request. Matches the kernel's `DESTINATION_TIMEOUT_MS`.
 */
export const AI_AUDIT_ANCHOR_TIMEOUT_MS = 2_000

// --- Tool / function calling ---
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
 * a tool loop tries to start. A tool-loop request is admitted only
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
 * Per-tenant integer metric names for tool calling, emitted best-effort
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
 * How long a minted action-tool confirmation stays spendable.
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
 * Per-tenant integer metrics for the confirmation flow.
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

// --- Resilience: request-path Redis reads ---
// Every request-path Redis read routes through the kernel `ResilienceService.run`
// via an injected `runResilient` closure, so a dependency outage degrades by a
// named POLICY (not an ad-hoc per-call try/catch) and emits a uniform
// `DependencyDegraded` event. The dependency name and the per-operation labels are
// fixed constants; the per-operation default policy is a named constant a host can
// override through `config.ai.resilience.<op>.policy`.

/** The logical dependency name for every AI Redis read, passed to `ResilienceService.run`. */
export const AI_RESILIENCE_DEPENDENCY_REDIS = 'redis'

/**
 * Default policy for the conversation-memory read: `fail-open`. A lost history
 * degrades gracefully (the chat runs with no prior turns, bounded by the memory
 * TTL); availability wins. Override via `config.ai.resilience.memory.policy`.
 */
export const DEFAULT_AI_RESILIENCE_MEMORY_POLICY: FailurePolicy = 'fail-open'

/**
 * Default policy for the idempotency read: `fail-open`. A skipped replay is safe
 * (the stream simply runs again); a replay convenience must never take the service
 * down. Override via `config.ai.resilience.idempotency.policy`.
 */
export const DEFAULT_AI_RESILIENCE_IDEMPOTENCY_POLICY: FailurePolicy = 'fail-open'

/**
 * Default policy for the per-key rate-limit consume: `fail-closed`. A blind cost
 * limiter that passes is a denial-of-wallet hole, so an outage refuses the request
 * (mapped to `rate_limit_unavailable`, 503). Override via
 * `config.ai.resilience.rateLimit.policy`.
 */
export const DEFAULT_AI_RESILIENCE_RATELIMIT_POLICY: FailurePolicy = 'fail-closed'

/** Operation labels for the resilience telemetry, one per request-path Redis read. Fixed, never inlined. */
export const AI_RESILIENCE_OP_MEMORY_LOAD = 'ai.memory.load'
export const AI_RESILIENCE_OP_IDEMPOTENCY_LOOKUP = 'ai.idempotency.lookup'
export const AI_RESILIENCE_OP_IDEMPOTENCY_SAVE = 'ai.idempotency.save'
export const AI_RESILIENCE_OP_RATE_LIMIT = 'ai.rate_limit.consume'

// --- Audit consumption pillar ---
// The read/query API, export, incremental verify, retention checkpoint, and anomaly
// watcher. Every bound is a named constant here; no consumption path ever rewrites a
// chained row (seq / checksum / prev_checksum); it reads and appends new artifacts.

/**
 * Default page size for `AiAuditReader.query`. Small on purpose: the audit read is a
 * forensic surface, not a bulk dump (that is `exportStream`). Tunable per request up
 * to {@link MAX_AI_AUDIT_PAGE_SIZE}.
 */
export const DEFAULT_AI_AUDIT_PAGE_SIZE = 50

/** Hard cap on one audit read page. Not host-tunable: it bounds one SELECT's row count. */
export const MAX_AI_AUDIT_PAGE_SIZE = 200

/**
 * Hard `page` ceiling (the OFFSET DoS bound, mirroring the admin controller): Postgres
 * `OFFSET` is O(n), so an unbounded `?page=10000&limit=200` reads and discards millions
 * of rows. Deep walks use the `[from,to]` time range to switch to a `(tenant_id, seq)`
 * range scan instead. Not host-tunable.
 */
export const MAX_AI_AUDIT_PAGE = 1000

/**
 * Rows per page the streaming export (`exportStream`) pulls at a time. Larger than the
 * interactive page size because an export is a bulk, backpressure-bounded walk; the
 * command awaits `drain` between writes, so this only bounds the in-flight batch, never
 * the whole file. Not host-tunable.
 */
export const DEFAULT_AI_AUDIT_EXPORT_BATCH_SIZE = 500

/**
 * The retention checkpoint table. A per-(tenant) signed high-water mark
 * `{ last_seq, last_checksum }` an incremental verify seeds FROM. It shares the
 * `backoffice` schema with the audit table (qualified via `qualifyBackofficeTable` with
 * the injected schema, never a `'backoffice'` literal) but is NOT append-only: a
 * checkpoint is upserted forward as `tenant:ai:audit:archive` advances it. Fixed constant.
 */
export const AI_AUDIT_CHECKPOINT_TABLE = 'ai_audit_checkpoints'

/**
 * Default sliding window for the anomaly watcher: guard-trip velocity is
 * counted per `(tenant, principal, guard)` over this window. 60s balances catching a
 * burst against smoothing normal operation. Tunable via `config.ai.audit.anomaly.windowMs`,
 * clamped to {@link MAX_AI_ANOMALY_WINDOW_MS}.
 */
export const DEFAULT_AI_ANOMALY_WINDOW_MS = 60_000

/** Hard ceiling on the anomaly window (1h), regardless of config. */
export const MAX_AI_ANOMALY_WINDOW_MS = 3_600_000

/**
 * Default trip-count threshold within one window that fires `guard.ai_anomaly`. Tunable
 * via `config.ai.audit.anomaly.threshold`, clamped to {@link MAX_AI_ANOMALY_THRESHOLD}.
 */
export const DEFAULT_AI_ANOMALY_THRESHOLD = 20

/** Hard ceiling on the anomaly threshold, regardless of config. */
export const MAX_AI_ANOMALY_THRESHOLD = 10_000

/**
 * Hard cap on the number of distinct `(tenant, principal, guard)` keys the watcher
 * tracks at once. An unbounded key space is itself a DoS (an attacker spraying distinct
 * principal hashes would grow the map without bound), so the oldest key is evicted at
 * this ceiling. Not host-tunable.
 */
export const MAX_AI_ANOMALY_TRACKED_KEYS = 10_000

/** The per-tenant anomaly metric name, emitted on a threshold breach. Fixed, never inlined. */
export const AI_ANOMALY_METRIC = 'ai_anomaly'

/** The per-tenant metric emitted when a scheduled/alerting verify finds a chain break. Fixed, never inlined. */
export const AI_AUDIT_CHAIN_BROKEN_METRIC = 'ai_audit_chain_broken'

// --- Data at rest (GATED default-off) ---
// Two seams and their validated config fields, both defaulting to EXACTLY today's
// behavior: conversation memory sealed under one fleet-wide APP_KEY, and embeddings
// content/metadata stored plaintext. Selecting `tenant-dek` memory or `encryptContent`
// embeddings is a SEPARATE per-host go (its own review); the plumbing here makes that a
// config flip, not a code change. Both at-rest paths seal through the optional crypto
// peer's per-`(subject × category)` DEK via its fail-closed field-encryption facade, so
// the AI package never touches a raw DEK or a crypto primitive and a crypto-shred makes
// the tenant's data cryptographically irrecoverable.

/**
 * The default conversation-memory encryption mode. `'app-key'` reproduces today
 * byte-for-byte (one fleet-wide `HKDF(APP_KEY)` key, the `aiConversationMemory` secret
 * class). Selecting `'tenant-dek'` is the strengthening: a per-tenant DEK so an APP_KEY
 * leak no longer decrypts every tenant's history and a shred erases one tenant's memory.
 * Tunable via `config.ai.memory.encryption`.
 */
export const DEFAULT_AI_MEMORY_ENCRYPTION = 'app-key'

/** The validated union of memory encryption modes. A value outside it is a boot `fail()`. */
export const AI_MEMORY_ENCRYPTION_MODES = ['app-key', 'tenant-dek'] as const

/**
 * The crypto DEK `CategoryKey` for conversation memory: one memory DEK per tenant on the
 * recommended single-subject scope (`subject = tenantId`). It carries the
 * {@link AI_MEMORY_SECRET_CLASS} domain-separation idiom onto the DEK side, so a memory
 * DEK cannot open an embeddings value or a domain field value. Fixed constant.
 */
export const AI_MEMORY_DEK_CATEGORY = 'ai:conversation-memory'

/**
 * The crypto DEK `CategoryKey` for embeddings content-at-rest, distinct from the memory
 * category so the two DEKs never cross. `subject = tenantId` (one embeddings DEK per
 * tenant). Fixed constant.
 */
export const AI_EMBEDDINGS_DEK_CATEGORY = 'ai:embeddings-content'

/**
 * Default for `config.ai.embedding.encryptContent`. False reproduces today (the `content`
 * column is plaintext). On, `content` seals to enc_v2 ciphertext under the embeddings DEK;
 * `content_hash` is UNAFFECTED (it hashes caller plaintext upstream of storage), so a
 * re-ingest still dedups. The vector column CANNOT be encrypted (ANN search needs it), so
 * this defends a raw text-column dump, not vector inversion.
 */
export const DEFAULT_AI_EMBEDDING_ENCRYPT_CONTENT = false

/**
 * Default for `config.ai.embedding.encryptMetadata`. False keeps metadata plaintext and
 * metadata-scoped retrieval working. On, the `metadata` column seals too, which DISABLES
 * metadata-scoped retrieval (`metadata @> ?::jsonb` cannot run over ciphertext), so a
 * `kind: 'metadata'` scope is then refused fail-closed with
 * `guard.ai_embedding_metadata_scope_conflict` rather than silently returning zero rows.
 */
export const DEFAULT_AI_EMBEDDING_ENCRYPT_METADATA = false

/**
 * Per-tenant counter for a memory read whose per-tenant DEK could not be resolved (KMS/
 * KeyProvider outage, or the DEK was shredded). Distinct from
 * {@link AI_MEMORY_UNDECRYPTABLE_METRIC} so a KMS outage is not mistaken for a botched
 * key rotation. The read still degrades to empty memory (fail-safe), matching today's
 * store-outage posture. Content-free.
 */
export const AI_MEMORY_DEK_UNAVAILABLE_METRIC = 'ai_memory_dek_unavailable'

/**
 * Per-tenant counter for a search row whose sealed `content`/`metadata` would not open
 * (the tenant corpus was shredded, or one row is corrupt). The row is dropped from the
 * result set (fail-safe), consistent with the memory read posture: a shredded-tenant
 * corpus reads empty, never 500. Content-free.
 */
export const AI_EMBEDDING_CONTENT_UNDECRYPTABLE_METRIC = 'ai_embedding_content_undecryptable'
