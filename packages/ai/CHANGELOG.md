# Changelog

All notable changes to `@adonisjs-lasagna/ai` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0]

**Introduced the AI satellite at release candidate**: the streaming spine and the
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

Documentation correction (per the ARCHITECTURE.md correction path): the design
doc's living sections now record the Isthmus integration decision (satellite
guards ride the kernel's public event channel; the kernel registry stays
closed), the gateway guard-emission paragraph, the ContextSeal constraint on
in-stream tenant queries, and the architectural test tier.
