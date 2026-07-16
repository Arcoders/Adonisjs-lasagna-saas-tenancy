# Changelog

All notable changes to `@adonisjs-lasagna/ai` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0]

**Introduced the AI satellite as experimental**: the streaming spine and the
provider abstraction that a future AI gateway calls through.

Added:
- **`AiConfig` config block** (`defineAiConfig`), validated eagerly at boot
  (`assertAiConfig`). Allow-list the providers a tenant may use (default-deny,
  G12), pick a default, and fill in the per-provider block. Every streaming
  tunable (heartbeat, timeout, per-request token cap) and every provider knob
  (base URL, model, Anthropic version) has a named-constant default and a config
  override, so nothing is hardcoded at a call site.
- **Provider contract + registry** (`AIProviderContract`, `AI_CONTRACT_VERSION`)
  with an unconditional streaming-presence gate at registration and a per-tenant
  default-deny allow-list, mirroring the billing provider pattern.
- **`StreamExtensionService`**: the SSE streaming integrator over the kernel's
  `executeExtension` and quota reservation seams, with backpressure, a tunable
  heartbeat, a four-way composed abort (timeout, liveness, client disconnect,
  budget early-stop), and per-chunk validate-then-settle clamped under the
  reservation worst case.
- **Three real providers** (Claude, DeepSeek, Kimi) that stream through the
  kernel's SSRF-pinned fetch with no vendor SDKs, selectable per tenant.
- **Observability**: the streamed call is wrapped in an `ai.stream` span
  (tenant / provider / model attributes only, never content) and emits integer
  usage metrics (`ai_requests`, `ai_tokens_total`, `ai_errors`,
  `ai_stream_disconnects`). No prompt or response text ever reaches telemetry.
- **The HTTP gateway** (`multitenancyAiRoutes` on the new `./routes` subpath;
  the main entry stays safe to import from `config/multitenancy.ts`):
  `POST /ai/chat` streams SSE through the single choke point in the
  ARCHITECTURE.md sequence order. Fail-closed mount (G4): no middleware chain,
  no `config.ai`, or no membership gate means no mount, with no public opt-out
  beyond an explicit `acknowledgeNoMembershipGate` that logs a warning and
  stays visible through the `ai_membership_gate` doctor check.
- **The AI membership gate** (`config.ai.authorizeAIAccess`, the kernel's
  `TenantAccessAuthorizer` contract): `false` or a throw denies with a 403,
  and a throwing hook is a fail-closed denial, never a 500. The controller
  re-runs the gate per request as a backstop against a mis-ordered chain.
- **Idempotent replays**: a completed response is cached per tenant +
  principal + session + `Idempotency-Key` (an HMAC scope under an HKDF key
  derived from APP_KEY; no scope component ever appears in a cache key) on the
  kernel's per-tenant cache namespace, and a retry replays the same bytes with
  `X-Ai-Idempotent-Replay: 1` at zero provider cost. Fail-open toward "no
  replay" on any cache doubt, with one privacy edge: an unreadable per-tenant
  epoch (the GDPR purge seam) also blocks saves, so a purge can never be
  silently undone. A malformed header is a 400 `invalid_request`.
- **Suspension mid-stream (G11)**: `TenantSuspended` / `TenantDeleted` abort
  that tenant's in-flight streams through the `TenantLivenessWatcher`
  singleton; streamed tokens still settle (same-pod; cross-pod enforcement
  stays with TenantGuard on the next request).
- **Satellite guard rail**: every fail-closed refusal (mount, access, provider
  and model allow-lists, config validation, the idempotency header bound)
  emits the kernel's public `IsthmusGuardTripped` event before throwing, from
  a satellite-local registry with `ai_`-namespaced ids, kernel budget values
  with satellite-local windows, counted drops, and a per-tenant
  `ai_guard_rejections` metric. A `no_silent_ai_guard` architecture scan plus
  a registry-driven emission matrix pin the discipline both ways.
- **The WS-AI-7 audit seam**: one attribution event per outcome at the choke
  point (non-PII field set pinned by an exact-keys spec; the principal is
  one-way hashed), with a no-op sink until the audit workstream lands storage.
- **Faithful pre-flight statuses**: a fatal typed refusal the provider raises
  before the first byte keeps its own pinned status instead of collapsing to a
  retryable 503. A model outside the per-provider allow-list is a 403
  (`provider_not_allowed`) and a BYOK endpoint the SSRF pin blocks is a 400
  (`byok_endpoint_blocked`), so a client retry loop never hammers a permanently
  denied model or endpoint. The gateway resolves every pre-flight status through
  the exception's single `httpStatusForAiCode` table, so the streaming spine and
  the controller can never drift into two status maps.
- **The cost governor bites (WS-AI-2)**: the `aiTokens` reserve rail is joined
  by a per-key request rate limit and a fail-loud budget posture.
  - `config.ai.rateLimit` `{ limit, windowSeconds }`: a per-tenant, per-provider-key
    request rate limit (threat #4, denial of wallet), a different rail from the
    token budget. Each request consumes one hit against
    `ext:ai:<op>:<tenant>:<keyFingerprint>` (the fingerprint a one-way hash of
    the active key, never the key); over the window is a fail-closed 429, a
    limiter-backend outage a fail-closed 503, and a replay served from cache
    consumes nothing. A denial rides the `IsthmusGuardTripped` channel as
    `guard.ai_rate_limited`.
  - The `ai_budget` doctor check surfaces the metering posture, and the provider
    logs a boot warning, when `aiTokens` is unbudgeted (no per-plan limit and no
    operator ceiling), so the endpoint never runs silently unmetered.
    `config.ai.acknowledgeUnbudgetedAiTokens` accepts the risk explicitly. There
    is no hard mount block: a dynamic per-tenant budget is invisible to the
    static boot read, so the posture stays advisory.
  - `AIProviderContract.keyFingerprint`: a one-way key fingerprint on the
    provider surface, feeding the rate-limit bucket and later the audit seam.
  - Real-Redis integration specs prove the cap bites end to end through the
    gateway spine (over-budget -> 402 with no bytes, the operator ceiling
    both-or-neither, the per-key window -> 429).
- **The vector store (WS-AI-3)**: per-tenant embeddings with structural isolation
  (invariant I1) and a fail-closed ingest choke point.
  - `AIEmbeddingProviderContract` + `MockEmbeddingProvider` + a generic
    `OpenAICompatibleEmbeddingProvider` (BYOK `baseUrl`/model over the SSRF-pinned
    fetch; no vendor SDK). The G12 model gate is shared with the chat providers.
  - `VectorStoreService`: placement resolved via the kernel `tableLocation(tenant)`
    seam (never a hardcoded `tenant_<id>`), a satellite ContextSeal that refuses a
    query whose tenant differs from the active scope (raw SQL bypasses the kernel
    seal), `rowscope-pg` refused outright, per-row `(model, dim)` binding, and
    idempotent `insert` (`ON CONFLICT (source, content_hash) DO NOTHING`) under an
    advisory-locked `embeddingCount` cap (threat #18).
  - `EmbeddingIngestionService` + `POST /ai/embed`: authorize-first, an optional
    `authorizeIngestion` write gate, `aiTokens` reserve/settle for the embed, an
    optional `sourceUrl` fetched through the SSRF pin (#11), and a parallel non-PII
    `AiEmbeddingAuditEvent`. New `config.ai.embedding` block (validated at boot),
    a per-tenant embeddings migration (the first satellite `perTenantMigrations`),
    and an opt-in `after:provision` hook that installs pgvector in a new
    database-pg tenant's DB before its migration runs.
  - Guards: `guard.ai_rowscope_refused`, `guard.ai_scope_mismatch`,
    `guard.ai_dimension_mismatch`, `guard.ai_embedding_quota_exhausted`,
    `guard.ai_ingestion_denied`; structural guards `check-ai-invariant-1` (I1
    placement) and `check-satellite-migrations` (compilation drift).
  - Adversarial-review hardening: the `sourceUrl` document fetch is streamed and
    aborted the instant it crosses `ingestionMaxBytes` (never buffered whole, so a
    huge public body that passes the SSRF pin cannot OOM the worker) and bounded by
    a new `config.ai.embedding.ingestionTimeoutMs` (default 10s) so a hung upstream
    cannot pin an ingest worker. The row dedup identity folds the `model` into
    `content_hash`, so re-embedding the same content under a different
    same-dimension model stores a fresh vector instead of a swallowed no-op. The
    database-pg `after:provision` pgvector hook now logs a per-database install
    failure instead of swallowing it silently.
- **Retrieval / RAG (WS-AI-5)**: the read half of the vector store, with a
  per-user document ACL and context integrity.
  - `config.ai.retrieval` block with `retrievalFilter(ctx, tenant)` (G2), the
    per-user document ACL. It returns a discriminated `RetrievalScope`
    (`{ kind: 'all' }` | `{ kind: 'sources', sources }` | `{ kind: 'metadata',
    match }`) that only NARROWS a search: the mandatory `(model, dim)` scope and
    the tenant placement always apply, and every scope value is a bound parameter.
    The hook is fail-closed (a throw or an invalid return is a 403
    `retrieval_denied` with a `guard.ai_retrieval_denied` trip, never a fallback
    to the whole corpus). An ABSENT hook is fail-closed too, mirroring the G4
    mount gate: every retrieval is refused (403 `retrieval_denied`) until the host
    either wires `retrievalFilter` or opts into tenant-wide retrieval with
    `acknowledgeUnscopedRetrieval`. The `ai_retrieval_gate` doctor check and a boot
    warning keep that decision visible.
  - `RetrievalService` + `POST /ai/retrieve`: authorize-first, resolve the
    document ACL, reserve `aiTokens` for the query embed (a metered read, G5),
    embed with the corpus's own provider, and search under the scope, filtering
    on the provider-reported effective model so a naming drift never returns zero
    rows. A parallel non-PII `AiRetrievalAuditEvent` (a `matchCount`, never the
    query or a document).
  - RAG into `/ai/chat`: an opt-in `retrieve: { query, limit? }` body field folds
    matches into the prompt on a cache miss. `buildRetrievalContext` (exported)
    renders them as a role-separated, fenced `user` turn (never a system turn), so
    retrieved content is untrusted data, not instructions (#10); the fence token
    is neutralized inside each document so a hostile doc cannot break out; and the
    block is bounded and trimmed so the assembled prompt never exceeds
    `maxPromptChars` (#8).
  - Structural guards: `check-ai-invariant-4` (the satellite never authors a
    system-role message, I4) and `check-ai-invariant-8` (every streaming response
    path applies an output bound, I8).
- **Audit (WS-AI-7)**: the three attribution seams (chat / embedding / retrieval)
  that shipped no-op now write append-only, non-PII, hash-chained rows (I5).
  - A dedicated backoffice `ai_audit_logs` table, published on `configure`, that
    replicates the kernel audit trigger set in full: a `no_mutate` function plus
    `BEFORE UPDATE`/`BEFORE DELETE` (row-level) and a statement-level `BEFORE
    TRUNCATE`, each raising regardless of role (#6). It survives
    `tenant:purge-expired` (it lives in the shared backoffice schema, not a tenant
    schema) and stores only non-PII metadata (counts, ids, model, one-way hashes),
    so GDPR erasure never has to chase content into the immutable log (#14, G1).
  - `AiAuditWriter`: a per-tenant `seq`+`checksum` hash chain, serialized by a
    transaction-scoped `pg_advisory_xact_lock` and backstopped by
    `UNIQUE(tenant_id, seq)` with a bounded retry, so a rewrite, deletion, or
    reorder that gets past the triggers (a superuser who disabled them) breaks the
    chain. Writes are fail-closed: a write outage is a 503 `audit_write_failed`
    with a `guard.ai_audit_write_failed` trip, and a completed SSE stream (which
    cannot be un-sent) instead trips the guard and leaves a detectable `seq` gap.
  - `tenant:ai:audit:verify` re-walks the chain and reports the first break
    (checksum / gap / prev-link), exiting non-zero for a cron or a post-incident
    gate. The `ai_audit` doctor check surfaces an un-provisioned table early.
  - External WORM/SIEM anchoring reuses the kernel `AuditLogDestinationRegistry`:
    each committed row is fanned out best-effort (time-bounded, isolated) so kernel
    audit and AI audit share one operator stream, without a duplicate admin-table
    row. A guard, `check-ai-invariant-5`, pins the trigger set and the fixed
    non-PII column allowlist.
- **Memory (WS-AI-4)**: per-(tenant, user, session) conversation history, encrypted
  at rest and replayed into the chat context as data (I2, #1).
  - `config.ai.memory` block (`maxTurns` / `maxChars` / `ttlMs`), opt-in: absent
    leaves `/ai/chat` stateless and `sessionId` its opaque idempotency-scope
    meaning. `ConversationMemoryService` stores each completed exchange as an
    enc_v2 blob (a new `SECRET_CLASS.aiConversationMemory`, its own HKDF context)
    in a per-session Redis LIST: an atomic `RPUSH` (so concurrent turns never lose
    each other), an `LTRIM` to the turn cap, and a sliding `PEXPIRE`.
  - Server-minted, HMAC-bound sessions (G6): the token is `<sid>.<sessionMac>`,
    bound to a `userMac = HMAC(tenant, principal)`; a supplied, forged, cross-user
    or cross-tenant token that does not verify against the CURRENT principal is a
    400 `memory_session_invalid` with a `guard.ai_memory_session_invalid` trip,
    before any load or persist. The two-segment storage key
    `ai:mem:<tenant>:<userMac>:<sessionMac>` gives WS-AI-9 a per-user and
    per-tenant `SCAN`+`DEL` purge (`purgeUser` / `purgeTenant`).
  - Gateway wiring: the first `/ai/chat` mints a session and returns it on the
    `X-Ai-Session` header (re-emitted on an idempotent replay, so a dropped turn-1
    is not lost); a supplied token replays the prior turns via `injectMemoryTurns`
    (exported) as user/assistant DATA after any leading system prompt, bounded to
    the budget left under `maxPromptChars`; the completed exchange is persisted from
    the reconstructed assistant text. A read fails SAFE (a store/decrypt failure, or
    an APP_KEY rotation past the `OLD_APP_KEY` dual-key grace, degrades to empty
    memory, bounded by the TTL); a persist failure is best-effort with a metric
    (`ai_memory_persist_failed` / `ai_memory_unreadable` /
    `ai_memory_decrypt_previous_used`) and a content-free warn.
  - Structural guard `check-ai-invariant-2` (I2): memory turns are never
    constructed `role: 'system'`, the write path encrypts (`encryptMemory`), and
    the session read validates (`timingSafeEqual`). The `ai_memory` doctor check
    surfaces an enabled-but-no-principal (inert) memory.
- **Compliance (WS-AI-9)**: GDPR-grade erasure and data residency over the purge
  seams the earlier workstreams shipped (#16, #15, #7, G1).
  - `AiComplianceService` composes the seams into a tenant / principal / document
    purge: the response-cache epoch rotates FIRST as a verifiably fail-closed gate
    (a rotation that cannot be read back throws, so a purge never starts without
    making pre-purge responses unreachable), then conversation memory, then
    embeddings, each best-effort-continue with an honest per-step summary
    (`ok` / `failed` / `skipped`) and a non-zero exit on any failure. Per-user
    erasure keys memory off the raw principal and embeddings off its one-way
    `actor` hash (the two are never conflated). Vector work runs inside
    `tenancy.run` so the raw-SQL ContextSeal actively protects, and a per-tenant
    Redis lock stops concurrent purges double-counting. The full-table and
    per-actor deletes are batched (`ctid IN (SELECT … LIMIT N)` under the
    per-tenant advisory lock), so a multi-million-row erasure runs in bounded,
    resumable chunks with an optional per-batch `statement_timeout` rather than one
    long lock or a wall-clock abort that would leave a partial purge.
  - `tenant:ai:purge` (operator-privileged): `--tenant --force` (all),
    `--principal` (one user, Art.17), `--source` (one document); `--dry-run`
    previews the counts and writes nothing (no delete, no epoch bump);
    `--verify-chain` folds a full audit-chain verify into the record. The admin
    action is recorded best-effort in the kernel audit (`ai.purge`, alongside
    `gdpr.anonymize`); the immutable, non-PII AI audit chain intentionally
    survives (G1).
  - Auto-purge: on the kernel `TenantDeleted` / `TenantAnonymized` events the AI
    layer clears the Redis-resident data (memory + cache epoch) — the schema is
    already dropped on destroy, and embeddings are kept on anonymize by design.
    The handlers are non-throwing (the core command has committed) but emit
    `guard.ai_auto_purge_failed` + `ai_auto_purge_failures`, so a silent failed
    erasure is impossible.
  - A memory re-population guard: a purge stamps a tombstone high-water mark, and
    an in-flight turn whose request began before the purge is dropped, so a late
    `RPUSH` cannot resurrect just-erased history past the memory TTL. The memory
    purge is `keyPrefix`-correct (it prepends a configured ioredis prefix to its
    `SCAN MATCH`, fail-closed if unresolvable) so a prefixed deployment is never a
    silent no-op, and uses `UNLINK` with a `DEL` fallback.
  - Data residency / no-train: `config.ai.residency` (a per-tenant resolver
    returning `{mode:'local-only'}` or an allowed-provider list) is enforced at
    request time on chat provider selection AND embedding egress (embed / retrieve
    / RAG query embed) — the egress a chat allow-list never sees — refusing a
    non-permitted provider or a remote endpoint under `local-only` with a 403
    `residency_denied` and `guard.ai_residency_denied`, fail-closed on a bad
    resolver. A structural guard, `check-ai-no-prompt-logging-for-training` (#15),
    keeps prompts / responses / documents / memory out of application logs.
  - `ai_compliance` doctor check (read-only Redis reachability + a `keyPrefix`
    note) and three `tenant:compliance:report` controls (AI data residency, AI
    right-to-erasure, and the transparency that embeddings survive anonymize).
- **Verification hardening (WS-AI-8)**: the chaos / resilience / enterprise test
  tier that exercises every earlier workstream under fault, plus the small hardenings
  an adversarial gap-hunt surfaced (the hunt found no production leak; the committed
  isolation, purge, and fail-closed guarantees all held).
  - New real-infrastructure specs: a vector-store outage during retrieval fails
    closed with the cost reservation released; the BYOK rate limiter fails closed
    (503 `rate_limit_unavailable`) under an injected Redis outage; concurrent audit
    writers for one tenant keep a contiguous, gap-free `(tenant_id, seq)` chain;
    APP_KEY rotation reads memory through the grace key then drops it fail-safe; a
    cross-principal idempotency collision stays in disjoint cache slots; two tenants
    sharing a provider fingerprint keep independent rate buckets; a many-tenant
    interleaved fuzz proves embeddings and memory never cross a tenant boundary; and
    a purge-completeness scan confirms every PII store is empty after `purgeTenant`
    while the immutable audit chain survives (G1).
  - `EmbeddingProviderRegistry`: a host override for the single embedding provider,
    mirroring `AIProviderRegistry` on the chat side. With no override the configured
    OpenAI-compatible backend is built exactly as before; a host (or an offline e2e)
    registers its own, resolved at make-time so a boot-time registration always wins.
  - Memory now emits `ai_memory_undecryptable` when a stored turn cannot be decrypted
    under any key (a botched APP_KEY rotation, corruption, or tampering), so a silent
    memory degradation is visible to operators instead of only warn-logged.
  - `check-ai-no-provider-prompt-cache`: an anti-drift guard pinning that no provider
    request builder emits a prompt-cache directive without a tenant-namespaced key.
  - A per-vector coverage matrix (all 18 threat vectors mapped to their covering spec
    with an on-disk existence check) and an end-to-end AI suite in the demo app
    (two-tenant isolation, the rate cap, a harmless injection, a poisoned RAG document
    that stays tenant-scoped).
- **Security documentation (WS-AI-10)**: a public AI security & threat-model page
  (`docs/guides/satellites/ai-security.md`) that publishes the 18-vector coverage
  matrix (each vector linked to its covering spec on GitHub), the eight invariants
  and their `check-ai-invariant-*` guards, the fail-closed postures and the three
  `acknowledge*` opt-outs (what risk each accepts), the honest residual limits, the
  guard / doctor / metric observability surface, and a production hardening
  checklist. The AI guide's lead is corrected (the vector store, RAG, conversation
  memory, audit and compliance all shipped, no longer "a later workstream"), and the
  retrieval-outage operations note (a store outage returns a non-2xx; operators
  monitor `ai_retrieval_errors`) is documented. Docs-only, no production-code change.
- **AI security hardening (WS-AI-10, follow-up)**: an OWASP LLM Top 10 (2025)
  coverage crosswalk on the security page (each category mapped to its covering
  vectors, invariants, and control), plus an optional host output-redaction seam.
  - `config.ai.redactOutput` `(ctx, tenant, chunk) => string | null`: a host DLP /
    PII-redaction hook applied per streamed chat fragment AFTER the mandatory I8
    output bound, so the bound always holds. It composes at the single fragment
    choke point, so the redacted bytes are what the client receives AND what the
    idempotency cache and conversation memory store: a replay serves the redacted
    bytes and the model never re-sees the raw output on the next turn. `tokens` are
    unchanged (cost is unaffected), and a redactor that throws or returns a
    non-string fails closed (the stream aborts, no un-redacted bytes). It is
    host-owned defense-in-depth, never the isolation control (I4/I8 remain the
    guarantee); a new content-free `ai_output_redacted` metric counts changes and
    aborts.
  - A validation of an external OWASP LLM 2025 report corrected the record: the
    vector store isolates via `tableLocation` + ContextSeal (not RLS), the SSRF
    guard both pins the validated IP and refuses redirects (the DNS-rebind /
    302-bypass classes are closed on the AI path), and injection / incident handling
    is deliberately harmless-by-isolation (I4), not regex detection.

Documentation correction (per the ARCHITECTURE.md correction path): the design
doc's living sections now record the Isthmus integration decision (satellite
guards ride the kernel's public event channel; the kernel registry stays
closed), the gateway guard-emission paragraph, the ContextSeal constraint on
in-stream tenant queries, and the architectural test tier.
