# 00 Foundation: the constitution for the AI hardening bundle

This file is settled relative to the other topic docs. Where a topic doc disagrees with it, this
file is right. It states the governing direction, the baseline of what already ships (so no wave
rebuilds a working control), the discipline every wave holds itself to, the honesty bound, and the
section template the topic docs are measured against.

## 1. The governing direction (non-negotiable)

No patches, no hacky or theater solutions, everything solved from the root, solid, and nothing
hardwired. Concretely, every item in this bundle is expressed as one of:

- a proper **seam** (an injected dependency or a host contract), or
- a **config field** validated at boot, or
- a **named constant** in `packages/ai/src/constants.ts`.

Never as a local `try/catch` that silently swallows, never as an inline literal, and never as a
schema or table string literal. Fail posture (fail-open versus fail-closed) is set by an **explicit
policy** attached to the seam, not by whether a particular caller remembered to wrap a call. Every
numeric bound, TTL, window, threshold, table name, and schedule is a named constant or a validated
`config.ai` field. Schema and connection names are always the injected `schemaName` / `connectionName`
dependencies, never a `'backoffice'` literal (a real past bug the codebase already guards with
`check-no-hardcoded-backoffice`).

Behavior-preserving refactors (Wave 0's `#runStream` split, the `FATAL_CODES` to `RETRYABILITY`
migration) are proven by their EXISTING regression specs staying green, not by new assertions that
would merely restate the refactor.

The one place the type system does not backstop correctness today is retryability: `FATAL_CODES` is
a hand-maintained `Set`, not compile-forced by the code union, and its own comment flags the drift.
Wave 0 removes that exception. After Wave 0, adding an error code without classifying its
retryability is a compile error, the same way adding one without a status already is.

## 2. The baseline ledger (already enterprise-grade, do not rebuild)

The following defenses ship today and are covered by specs and source-scan guards. A wave that
touches this surface preserves the property; it does not re-implement it. File anchors are given so
a wave can find the seam it must not break.

**Structural prompt-injection defense (not detection).** The client-facing `parseChatBody`
(`ai_chat_controller.ts`) admits only `system` / `user` / `assistant` roles and reads only the
`role` and `content` keys, so a client can never forge an `assistant.toolCalls` turn or a
`role:'tool'` result. Every tool turn is server-authored. RAG and memory are always folded in as
`user` / `assistant` / `tool` turns, never `system` (invariant I4, pinned by `check-ai-invariant-4`),
each fenced and neutralized (`neutralizeFence` in `context_builder.ts`, `neutralizeToolFence` in
`tool_executor.ts`, both case-insensitive). The fence and preamble are explicitly defense-in-depth;
the real control is role separation plus I4. Wave 3 makes this structural layer OBSERVABLE and adds
a pluggable semantic seam on top. It does not replace the structural boundary and it does not ship a
regex wall as the boundary.

**SSRF egress control (in core, consumed by AI).** The kernel `safe_fetch.ts` pins every connection
to one pre-validated IP via a custom DNS lookup (closing DNS-rebinding TOCTOU), presents the real
hostname for Host/SNI/cert, refuses to follow 3xx redirects, is https-only, and streams under a
byte-cap. A source-scan guard forbids reaching the network any other way. The AI providers are thin
HTTP+SSE adapters over this pinned fetch and ship zero vendor SDKs (peer deps only). A BYOK `baseUrl`
stays IP-pinned; a private/metadata endpoint surfaces as `byok_endpoint_blocked`. No wave weakens
this.

**Tenant isolation on raw SQL.** The vector store, the audit writer, and the action ledger each
re-assert the active tenancy scope id equals the row tenant before any raw query (raw SQL bypasses
the kernel ContextSeal), emitting `guard.ai_scope_mismatch` with the foreign id tokenized, and
throwing `tenant_scope_mismatch` on a mismatch. Vector placement resolves via
`driver.tableLocation(tenant)`; rowscope-pg is refused outright (`rowscope_unsupported`) because
embeddings invert to source text. Memory keys are HMAC-namespaced `ai:mem:<tenant>:<userMac>:<sessionMac>`
with `userMac = HMAC(tenant, principal)`; session tokens are `timingSafeEqual`-verified and fail
closed. Wave 4's read/export surfaces and Wave 5's at-rest encryption both inherit this
re-assert-before-raw-SQL rule.

**Denial-of-wallet rails.** A fail-closed token-cost reserve/settle/release around the whole run
(reserve before the provider call, settle actuals, release in a fail-open `finally`; backend outage
resolves 503, over-budget 402), plus a separate per-key rate limiter keyed
`ext:ai:<op>:<tenant>:<keyFingerprint>` (429 over window, 503 fail-closed on outage). Tool loops add
hard ceilings: rounds (4/8), tools-per-round (4/8), total calls-per-request (16), per-tool timeout
(5s/30s), concurrent loops per tenant (8/32). The honest limit is that an unbudgeted `aiTokens`
quota runs UNMETERED unless acknowledged; Wave 1 turns that boot-time warning into a fail-closed
boot abort (with the existing acknowledge escape hatch preserved).

**Audit integrity.** `backoffice.ai_audit_logs` is DB-level append-only (BEFORE UPDATE/DELETE/TRUNCATE
triggers `RAISE insufficient_privilege` for every role, owner included) plus a per-tenant `seq` +
sha256 hash chain (`checksum = sha256(canonical(row, seq) + '\n' + prev_checksum)`) serialized by a
per-tenant advisory xact lock, with `UNIQUE(tenant_id, seq)`. Rows are non-PII (principal and source
are one-way sha256; no prompt, response, query, document, tool-arg, or tool-result text, enforced by
`check-ai-invariant-5`). Writes fail closed. `verify()` re-walks the chain and catches tampering that
disabled and re-enabled the triggers. Wave 4 builds the CONSUMPTION surfaces (read, export, checkpoint
verify, retention, anomaly) on this chain without ever rewriting a `prev_checksum`.

**Provider posture.** Per-tenant default-deny provider allow-list, per-provider default-deny model
allow-list, key fingerprinting (sha256 of the API key, never the key), an unconditional
streaming-capability gate at registration, and a per-tenant residency gate resolved fail-closed at
both chat and embedding egress before any spend.

**The guard registry and the anti-drift matrix.** The satellite runs its own `AI_GUARD_REGISTRY`
(27 entries today), collision-proof against the kernel registry by the mandatory `ai_` id segment.
Adding a guard is a fixed four-step act (registry literal, `emitAiGuardEvent` before the throw,
a behavioral emission recipe in the emission-matrix spec, keep `no_silent_ai_guard` green). A
threat-vector coverage matrix (`ai_threat_vector_coverage_matrix.spec.ts`) pins each of the 18
vectors to a covering spec on disk. Every new guard this bundle adds follows the four-step act; Wave 2
extends the matrix so a vector can carry MORE than one fault spec.

## 3. The genuine gaps this bundle closes (ranked in `01`)

Stated plainly so a reader knows what is NOT yet enterprise-grade:

- **Data protection.** Embeddings `content` and `metadata` sit plaintext at rest; conversation memory
  is sealed under a single fleet-wide APP_KEY (one key compromise exposes every tenant). Wave 5.
- **Audit consumption.** The chain is bulletproof to WRITE but there is no read/query API, no export,
  no incremental verify, no retention story, and no anomaly alerting. Wave 4.
- **Resilience.** Three request-path Redis reads degrade via ad-hoc `try/catch` with no shared policy;
  a DB outage in the vector store surfaces as an untyped 500; the chaos tier only exercises the tool
  loop. Waves 0, 1, 2.
- **Code quality drift risks.** `FATAL_CODES` is a hand-maintained `Set` (its own comment documents
  the hazard); `#runStream` is a ~143-line hotspot; three Redis seams are `Promise<any>`; the
  unmetered-`aiTokens` fallback only warns. Wave 0 and Wave 1.

The two "latent bugs" a naive first pass would patch locally (an idempotency-lookup Redis outage
500ing the request; a vector-store DB outage surfacing as an opaque 500) are NOT patched with a local
catch. They are DISSOLVED at the root by the Wave-1 resilience foundation: once fail-open is the
policy on the memory and idempotency reads, and once the vector store funnels every raw query through
one boundary that classifies a transport outage into a typed retryable 503, no consumer needs a local
catch or a per-caller error map.

## 4. Discipline every wave holds to

1. **Every wave is an independent PR**, red-first (a failing spec that states the gap, then the fix),
   gated by `npm run check` plus `npm run typecheck` (after `npm run build:all`) plus eslint and
   prettier, keeping the guarantee-tree and threat-vector-matrix guards green.
2. **Commit as `arcoders`, no Co-Authored-By trailer.** Nothing is pushed without the user's word.
3. **Every numeric bound is a `DEFAULT_*` / `MAX_*` pair in `constants.ts`**, the `MAX_*` imported
   into `validate_config.ts` and asserted with `assertBoundedInteger`. Non-tunable hard caps carry
   "Not host-tunable" in their JSDoc. A TTL or threshold invariant that couples two constants is
   pinned by an architectural spec, not just a comment (the `TOOL_ACTION_LEDGER_TTL_MS >= TOOL_CONFIRMATION_TTL_MS`
   precedent).
4. **Every new host seam ships BOTH a `typeof === 'function'` boot check AND a request-time
   fail-closed consumer.** Boot validation never inspects a hook's return value; the return-shape
   guarantee is the request-time gate. This is the established pattern for `RetrievalFilter`,
   `AIToolAuthorizer`, `ResidencyResolver`.
5. **Every validation branch routes through `fail()`** in `validate_config.ts` (the single choke that
   emits `guard.ai_config_invalid`), never a bare throw.
6. **Every new outcome is an observable named-constant metric and/or a registered guard**, emitted
   best-effort off the reject path, never a silent state change.
7. **A relaxed fail-closed default carries a paired `acknowledge<X>` boolean and a doctor check**, so
   a host that opts out of a safety default does so visibly (the `acknowledgeUnscopedRetrieval` /
   `acknowledgeNoMembershipGate` precedent).

## 5. The honesty bound (what this bundle does NOT guarantee)

- It does not make the AI satellite "unhackable" or "prompt-injection-proof". Wave 3 adds an
  observable structural signal and a pluggable semantic seam; the semantic detector is optional,
  overridable, and explicitly NOT the boundary. The boundary remains structural role separation.
- Wave 5 content-at-rest encryption defends a raw text-column dump. It does NOT defend against vector
  inversion: the plaintext embedding vector remains approximately invertible to source text, and the
  vector cannot be encrypted without losing ANN search. Physical isolation stays the real embedding
  control.
- The audit chain (and Wave 4's consumption surfaces) detect tampering; they do not PREVENT a
  superuser from dropping the table. Detection is off-box, via the chain plus an external anchor,
  warned by the `ai_audit` doctor check.
- These mechanisms do not decide, on the operator's behalf, whether any processing activity is lawful.
  Compliance is a property of the operator (the data controller), not of this library. This bundle
  stands PENDING LEGAL ADVICE where it touches erasure and retention; the operator's counsel has the
  final word.

## 6. The section template (every topic doc closes with these)

Each topic doc (`01` through `06`) is structured so a reviewer can check it the same way:

1. **What already ships** on this topic (the baseline, with anchors) so the delta is clear.
2. **The gap**, stated as a concrete failure the current code exhibits.
3. **The root-cause mitigation**: the seam or contract, its fail posture (fail-open / fail-closed and
   why), the named constants introduced, and the guard or metric that makes it observable.
4. **Acceptance tests**: the red-first spec that states the gap and the green condition.
5. **The honesty bound**: what this mitigation does NOT cover.
6. **Open decisions owned by the user**: the choices left to the operator, each with a recommended
   default.
