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

Documentation correction (per the ARCHITECTURE.md correction path): the design
doc's living sections now record the Isthmus integration decision (satellite
guards ride the kernel's public event channel; the kernel registry stays
closed), the gateway guard-emission paragraph, the ContextSeal constraint on
in-stream tenant queries, and the architectural test tier.
