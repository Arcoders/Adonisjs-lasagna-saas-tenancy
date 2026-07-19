# 01 Threat model: OWASP LLM Top 10 (2025) delta + risk matrix

This doc is the DELTA on top of the shipped threat model in
`docs/guides/satellites/ai-security.md`. That page already carries the satellite's own
18-vector taxonomy (`ai-security.md` L32-51), the eight structural invariants I1 through I8
(L64-73), an OWASP LLM Top 10 crosswalk (L83-94), the honest-limits section (L138-168), and
the guard-id catalogue (L194-213). None of that is repeated here. This doc states two things
the page does not: (a) for each OWASP 2025 category, the RESIDUAL gap this bundle closes and
in which wave, or "already covered"; and (b) a probability x impact ranking of the genuine
gaps, which is what decided the wave order. Where this doc and `00-foundation.md` disagree,
the foundation is right.

## What "enterprise-grade" means here

Not "unhackable" and not "prompt-injection-proof" (the framing principle in the README is
explicit that security is a property the operator earns, never a claim the library makes).
Concretely it means four measurable properties, three of which already hold and one of which
this bundle finishes:

- **Cross-tenant leakage is held at 0 by construction, not by detection.** The model's context
  is tenant-pure (invariant I4, `ai-security.md` L69), so a successful injection has nothing
  foreign to retrieve, and every store is physically tenant-scoped (I1, L66). This ships.
- **Chaos coverage per vector.** Every vector maps to a red-first covering spec pinned by the
  anti-drift matrix (`ai_threat_vector_coverage_matrix.spec.ts`, `ai-security.md` L26-27), and
  vectors 9 and 17 that carry no fault spec record the reason in the matrix so the gap is
  auditable, not silent (L53-56). This ships; Wave 2 extends the matrix so one vector can carry
  MORE than one fault spec, and closes the "chaos tier is tool-loop-only" gap (`00-foundation.md`
  section 2, last paragraph).
- **The denial-of-wallet rails are provably non-inert.** Reserve/settle is fail-closed
  (I3, `ai-security.md` L68) with the honest hole that an unbudgeted `aiTokens` plan runs
  UNMETERED and only WARNS at boot (`ai_budget_check.ts:47`, `:75-76`, `:92`). Wave 1 turns that
  warning into a fail-closed boot abort, preserving the existing acknowledge escape hatch
  (`acknowledgeUnbudgetedAiTokens`, `define_config.ts:457`).
- **Audit consumption surfaces are shipped.** Today the chain is bulletproof to WRITE
  (`00-foundation.md` section 2, "Audit integrity") but has no read/export/incremental-verify/
  retention/anomaly path. Wave 4 builds those on the existing chain without ever rewriting a
  `prev_checksum`.

The load-bearing point, restated so no wave rebuilds a working control: MOST defenses an
"enterprise-grade AI" brief worries about already ship and are spec-covered. The complete
baseline is enumerated in `00-foundation.md` section 2 (the baseline ledger). This doc ranks
only what is genuinely NOT yet enterprise-grade.

## OWASP LLM Top 10 (2025): the delta table

The existing crosswalk (`ai-security.md` L83-94) states, per category, how the satellite
addresses it TODAY. This table adds one column the page lacks: the residual gap this bundle
closes and the wave that closes it. Read it alongside the page, not instead of it.

| OWASP 2025 | Already ships (anchor) | Residual gap this bundle closes -> wave |
|---|---|---|
| **LLM01** Prompt Injection | Structural boundary: `parseChatBody` admits only `system`/`user`/`assistant` and reads only `role`/`content`, so a client cannot forge an `assistant.toolCalls` or `role:'tool'` turn; RAG/memory fold in as data, never `system` (I4, pinned by `check-ai-invariant-4`); fences neutralized (`00-foundation.md` section 2, "Structural prompt-injection defense"). | The structural layer is not OBSERVABLE and there is no semantic seam. **Wave 3** adds an observable structural signal and a pluggable async `InjectionClassifier` host contract on TOP of the boundary. It NEVER replaces the structural boundary and ships no regex wall as the boundary (`00-foundation.md` section 5, first bullet). |
| **LLM02** Sensitive Information Disclosure | Audit rows are non-PII (principal/source one-way sha256; no prompt/response/query/doc/tool text, pinned by `check-ai-invariant-5`); residency egress allow-list; no-prompt-logging guard; uniform errors; optional `redactOutput` DLP seam (`ai-security.md` L86, L138-168). | Data-at-rest: embeddings `content`/`metadata` sit plaintext at rest, and conversation memory is sealed under one fleet-wide APP_KEY (one key compromise exposes every tenant). **Wave 5** closes content-at-rest for memory (per-tenant DEK) and embeddings content, designed and plumbed default-off. |
| **LLM03** Supply Chain | No model artifacts loaded (providers are remote HTTP+SSE adapters, zero vendor SDKs, peer deps only); per-tenant encrypted BYOK keys; SSRF-pinned egress via the kernel `safe_fetch` (`ai-security.md` L87, `00-foundation.md` section 2, "SSRF egress control"). Provider-SDK/endpoint trust is a stated residual (`ai-security.md` L161-164). | No gap this bundle closes. The provider trust boundary is a documented, irreducible residual, not a defect. Already covered. |
| **LLM04** Data & Model Poisoning | Retrieved content is untrusted DATA, not instructions (role + fenced delimiter, vector #10); ingestion gated by `authorizeIngestion` with per-row provenance and rollback-by-source; physical tenant isolation bounds blast radius (`ai-security.md` L88, L43). | No gap this bundle closes. Retrieved content is already fenced and harmless by I4. Already covered. |
| **LLM05** Improper Output Handling | Mandatory per-fragment output bound on every response path (I8); optional host `redactOutput` DLP composed AFTER the bound, fail-closed on throw/non-string (`ai-security.md` L89, L96-109). | No gap this bundle closes. The bound is mandatory; the DLP seam's per-fragment limit is a stated honest residual (`ai-security.md` L155-160), not a defect. Already covered. |
| **LLM06** Excessive Agency | Default-deny tool registry; `authorizeTool` denies unless wired (I7); every call scoped, argument-whitelist-reconstructed, audited; loop hard ceilings (rounds `DEFAULT_AI_MAX_TOOL_ROUNDS`/`MAX_AI_TOOL_ROUNDS`, per-round `MAX_TOOLS_PER_ROUND`, `MAX_TOOL_CALLS_PER_REQUEST`, `MAX_TOOL_TIMEOUT_MS`, `MAX_CONCURRENT_TOOL_LOOPS_PER_TENANT`); mutating `action` tools off behind a kill-switch, and once on run only after a human confirms a signed challenge (`ai-security.md` L90, L45). | No gap this bundle closes. HITL confirmation and the tool ceilings ship (WS-AI-11 Phase 3a). The honest bound already stated: confirmation stops autonomy, not the injection itself (`ai-security.md` L90, last sentence). Already covered. |
| **LLM07** System Prompt Leakage | The system prompt carries no secret, key, or tenant data (authorization lives in code, not the prompt); output handling never discloses it (I4, I8, `ai-security.md` L91). | No gap this bundle closes. Secret-free-prompt is a structural property, not a control to add. Already covered. |
| **LLM08** Vector & Embedding Weaknesses | Physically tenant-scoped vectors via `driver.tableLocation(tenant)` + ContextSeal + `guard.ai_scope_mismatch`; `rowscope-pg` REFUSED outright (`rowscope_unsupported`) because embeddings invert to source text; per-plan `embeddingCount` quota (`ai-security.md` L92, L66, `00-foundation.md` section 2, "Tenant isolation on raw SQL"). | Partial: the embedding `content` column is plaintext at rest. **Wave 5** adds content-at-rest encryption for the source text, with the honest bound stated below (the vector itself stays invertible). |
| **LLM09** Misinformation | Cross-tenant leakage is 0 by construction (I4); the residual is model hallucination, a quality risk, documented as an honest limit (`ai-security.md` L93, L148-151). | No gap this bundle closes. Hallucination is a quality property, not an isolation fault (recorded in the coverage matrix, `ai-security.md` L53-56). Already covered. |
| **LLM10** Unbounded Consumption | Fail-closed `aiTokens` reserve/settle (I3); operator ceiling; per-key rate limiter keyed `ext:ai:<op>:<tenant>:<keyFingerprint>` (429 over window, 503 fail-closed on outage); prompt/context bounds; per-tenant concurrent-loop admission cap (`ai-security.md` L94, L46, `00-foundation.md` section 2, "Denial-of-wallet rails"). | The one hole: an unbudgeted plan runs UNMETERED, warn-only at boot (`ai_budget_check.ts:47`, `:92`). **Wave 1** fail-closes that path at boot (abort, not warn), keeping `acknowledgeUnbudgetedAiTokens`; and the two latent request-path 500s (idempotency/memory Redis outage, vector-store DB outage) are DISSOLVED at the root by the Wave-1 resilience foundation, not patched with local catches (`00-foundation.md` section 3). |

Reading the delta column top to bottom: of the ten categories, six are already covered with no
gap this bundle closes (LLM03, LLM04, LLM05, LLM06, LLM07, LLM09), and four carry a residual
this bundle closes (LLM01 -> Wave 3, LLM02 and LLM08 -> Wave 5, LLM10 -> Wave 1). That
distribution is the point: the bundle is a small number of root-cause closes on an
already-dense baseline, not a rewrite.

## The risk matrix: ranking the genuine gaps

These are the gaps enumerated in `00-foundation.md` section 3, ranked by Likelihood x Impact so
the wave order is a consequence of risk, not taste. Likelihood is "how often this actually bites
a running deployment"; Impact is the blast radius when it does. The rank column is the resulting
priority.

| Rank | Gap | Likelihood | Impact | Wave | Justification (one line) |
|---|---|---|---|---|---|
| 1 | **Latent 500: idempotency/memory Redis outage** | Med | Med | 1 | Three request-path Redis reads degrade via ad-hoc `try/catch` with no shared policy (`00-foundation.md` section 3); a Redis blip 500s a request that should fail-open and serve. A Redis restart is an ordinary operational event, so likelihood is real, not theoretical. |
| 2 | **Latent 500: vector-store DB outage** | Med | Med | 1 (foundation), 2 (chaos) | Every `rawQuery` in `vector_store_service.ts` (`:132`, `:207`, `:300`, ...) propagates a raw pg transport error untyped, surfacing as an opaque 500 (`ai-security.md` L256-262 documents this today). The Wave-1 boundary classifies a transport outage into a typed retryable 503; Wave 2's chaos tier proves it. |
| 3 | **Unmetered `aiTokens` is warn-only** | Med | High | 1 | An operator who forgets to budget a plan runs the cost surface UNMETERED, and the only signal is a boot WARNING (`ai_budget_check.ts:47`, `:92`) easy to miss in CI noise. Impact is High: denial-of-wallet on a shared provider account. Likelihood Med: a forgotten plan budget is a common misconfiguration. |
| 4 | **Data-at-rest: memory single-APP_KEY blast radius** | Low | High | 5 | Conversation memory is sealed under one fleet-wide APP_KEY, so one key compromise exposes EVERY tenant's memory (`00-foundation.md` section 3). Likelihood Low (APP_KEY compromise is rare and already gated by kernel secret discipline); Impact High (fleet-wide). Gated default-off; enabling per host is a separate go. |
| 5 | **Data-at-rest: embeddings content plaintext** | Low | High | 5 | The embedding `content`/`metadata` columns sit plaintext at rest, so a raw table dump reads source text. Likelihood Low (needs DB-level access past tenant isolation); Impact High (source-text disclosure). Honest bound: encryption defends a dump, NOT vector inversion (below). |
| 6 | **Audit consumption absent** | Med | Med | 4 | The chain is bulletproof to WRITE but there is no read/query API, no export, no incremental verify, no retention, no anomaly alerting (`00-foundation.md` section 3). Likelihood Med (every compliance review asks to READ the log); Impact Med (the integrity guarantee is real but unusable until you can consume it). |
| 7 | **Code-quality drift: `FATAL_CODES` hand-Set** | Low | Med | 0 | Retryability is a hand-maintained `Set` NOT compile-forced by the code union, and its own comment flags the hazard (`ai_exception.ts:148-151`): a new error code added without classifying retryability is silently "retryable", so a client retries the very egress residency exists to block. Likelihood Low (only bites when a code is added); Impact Med (wrong retry on a permanent refusal). Wave 0 makes omission a compile error. |
| 8 | **Code-quality drift: `#runStream` 143-line hotspot** | Low | Low | 0 | `#runStream` in `stream_extension.ts:242` runs ~143 lines to the next function boundary at `:385`, mixing preflight, abort composition, and streaming. A hotspot that large is where the next bug hides. Behavior-preserving split, proven by EXISTING regression specs staying green (`00-foundation.md` section 1). |
| 9 | **Code-quality drift: three `Promise<any>` Redis seams** | Low | Low | 0/1 | `conversation_memory_service.ts:82`, `ai_compliance_service.ts:82`, `ai_compliance_check.ts:7` each type their Redis handle as `Promise<any>`, erasing the type system exactly where the resilience policy attaches. Typed in Wave 0, consumed by the Wave-1 policy seam. |

### Why Waves 0 and 1 come first

The ordering is not arbitrary and it is not "easiest first". Waves 0 and 1 rank first because
they DISSOLVE the two top-ranked latent 500 bugs at the root and lay the foundation the chaos
tier (Wave 2) verifies:

- The two latent 500s (ranks 1 and 2) are NOT patched with a local `try/catch`. That would be
  the theater the governing direction forbids (`00-foundation.md` section 1). They are dissolved
  by making fail-open the POLICY on the memory and idempotency reads, and by funnelling every
  vector-store `rawQuery` through one boundary that classifies a transport outage into a typed
  retryable 503. Once that policy exists, no consumer needs a local catch or a per-caller error
  map (`00-foundation.md` section 3, last paragraph).
- That resilience foundation only has teeth if the type system reaches the seams it attaches to,
  which is why the `Promise<any>` Redis seams (rank 9) and the `FATAL_CODES` compile-forcing
  (rank 7) are Wave 0, immediately before Wave 1 consumes them.
- Wave 2's chaos tier verifies the Wave-1 behavior. You cannot write a "Redis is down, the
  request still serves" chaos spec against ad-hoc catches with no shared policy; you can against
  one policy seam. So the chaos extension depends on Wave 1 landing first.

Ranks 3 through 6 (unmetered spend, the two data-at-rest items, audit consumption) are
independent of the foundation and of each other, EXCEPT that Wave 1 also carries the unmetered
fail-close because it is the same "make the fail posture a policy, not a warning" move. Wave 5
(ranks 4 and 5) is designed here but gated behind a separate go.

## Doc-drift finding to reconcile

`ai-security.md` states "The satellite ships **18 guards**" (L189) and its guard-id table lists
18 rows (L194-213). The live `AI_GUARD_REGISTRY` (`packages/ai/src/isthmus/ai_guard_registry.ts`)
carries **27** entries. The gap is the nine WS-AI-11 tool/action guards added after the page was
written: `guard.ai_tool_unknown`, `guard.ai_tool_denied`, `guard.ai_tool_input_invalid`,
`guard.ai_tool_scope_mismatch`, `guard.ai_tool_budget_exhausted`, `guard.ai_tool_action_disabled`,
`guard.ai_too_many_concurrent`, `guard.ai_tool_confirmation_unmatched`, and
`guard.ai_action_ledger_unavailable`. The last of these
(`ai_guard_registry.ts:478-491`, the at-most-once fence for a confirmed action tool, severity
`high` because a tenant whose action-ledger write fails has action tools DOWN, which is correct
but is an availability event an operator must see) is the clearest example of a shipped,
registry-backed guard the page's table omits.

This is a documentation drift, not a code defect: the registry is the source of truth and is
already collision-proof and anti-drift-guarded (`00-foundation.md` section 2, last paragraph).
The reconciliation is a doc edit, done in the SAME PR as whichever wave next touches the page
(the README already flags this: "the page's '18 guards' figure predates the WS-AI-11 additions",
README L74-75). Wave 4 is the natural home, since it corrects the first-class `ai` actor and
touches the audit/guard surface anyway (README L37).

## Acceptance tests

This doc introduces no mechanism, so its "acceptance" is that the delta and the ranking stay
true as the waves land. Two checks make that mechanical rather than a promise:

- The threat-vector coverage matrix (`ai_threat_vector_coverage_matrix.spec.ts`) stays green,
  and Wave 2 extends it so a vector can carry more than one fault spec (`00-foundation.md`
  section 2). A new wave that adds a fault spec without matrix-registering it is a hard CI
  failure.
- The guard-count reconciliation is verifiable by comparing `AI_GUARD_REGISTRY.length` against
  the page's stated figure. When the page is edited to 27, the two agree; until then this doc is
  the record of the discrepancy.

Per-wave red-first acceptance specs live in each wave's own doc (`02` through `05`) and in the
execution plan (`06`), not here.

## Honesty bound

This is a ranking document, and a ranking hides things a flat list would not, so the edges are
stated plainly:

- **The ranking is a judgement, not a measurement.** Likelihood and Impact are Low/Med/High
  bands set from operational experience, not from incident telemetry this repo has collected.
  An operator whose deployment differs (no Redis, no embeddings, a hard-budgeted plan) should
  re-rank for their surface. The wave ORDER is defended by dependency (Waves 0/1 underpin 2),
  which is objective; the priority WITHIN the independent tail (3 through 6) is defensible but
  not unique.
- **Closing every ranked gap does not make the satellite unhackable or prompt-injection-proof.**
  Wave 3 adds an observable structural signal and a pluggable semantic seam; the semantic
  detector is optional, overridable, and explicitly NOT the boundary. The boundary remains
  structural role separation (`00-foundation.md` section 5).
- **Wave 5 defends a raw text-column dump, not vector inversion.** The plaintext embedding
  VECTOR stays approximately invertible to source text, and it cannot be encrypted without
  losing ANN search. Physical isolation (I1) stays the real embedding control; content-at-rest
  encryption is defense-in-depth on top of it (`00-foundation.md` section 5, second bullet;
  `ai-security.md` L49).
- **The data-at-rest items are ranked but gated.** Ranks 4 and 5 are designed and plumbed
  default-off. Their presence in the matrix does NOT mean they ship enabled; flipping any host to
  `tenant-dek` memory or `encryptContent` embeddings is a separate go with its own review (README
  L59-60).
- **This bundle does not decide lawfulness.** Compliance is a property of the operator (the data
  controller), not of this library. Where the ranking touches erasure and retention (rank 6), it
  stands PENDING LEGAL ADVICE; the operator's counsel has the final word (`00-foundation.md`
  section 5, last bullet).

## Open decisions owned by the user

Each topic doc restates the open decisions it touches; this framing doc owns the one decision
about the ranking itself, and points at the rest.

1. **Wave ordering past the foundation (recommended default: `0 -> 1 -> 2 -> 3 -> 4 -> 5`).**
   Waves 0 and 1 first is not negotiable inside this recommendation, because they dissolve the
   two top-ranked latent 500s and underpin the chaos tier. Waves 3 and 4 are largely independent
   and could swap if a compliance deadline pulls audit consumption forward; that is the operator's
   call. Wave 5 stays last and gated (README L61-63).
2. **Whether to accept the ranking's band assignments for your deployment.** The recommended
   default is to accept them as written, since they match the executed plan. An operator with a
   materially different surface (see the honesty bound) should re-rank and say so; the wave
   dependencies still hold, only the tail priority moves.
3. **When to reconcile the "18 guards" figure to 27 (recommended default: in the Wave 4 PR).**
   Wave 4 touches the audit/guard surface and the first-class `ai` actor anyway, so folding the
   doc edit there costs nothing extra. Doing it sooner as a standalone doc-only PR is also fine
   and carries zero code risk.

The decisions owned by later waves (Wave-1 resilience policy home, Wave-3 semantic default,
Wave-4 scheduling, Wave-5 enablement) are restated in `02` through `05` and consolidated in the
README's "Open decisions owned by the user" section (README L46-63).
