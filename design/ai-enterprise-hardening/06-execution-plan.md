# 06 Execution plan, acceptance tests, and success metrics

This is the operational doc: the wave ordering and why it is the only order that makes sense, the per-wave red-first acceptance tests, the exact verification recipe against the real stack (unit, integration, chaos, guards, and an end-to-end drive of the rental app), and the success metrics that say the bundle actually closed the gaps in `01` rather than restating them. Where a claim about a wave's mechanism lives in another topic doc, this doc names the wave and points there rather than re-deriving it. The discipline every wave holds to is the `00-foundation.md` section 4 checklist, not repeated here except where a wave's acceptance test IS the observable that the checklist demands.

## 1. What already ships (so the plan does not rebuild it)

Two test tiers and one anti-drift matrix already exist and are the substrate this plan extends, not replaces.

The **chaos tier** is real and already boots the real stack. `packages/ai/bin/test.fault.ts` runs `runIntegrationSuite` against core's canonical fixture (`fixtureRoot` points at `../../core/tests/fixtures/`) over the same real Postgres and Redis as the integration tier, selects only `guaranteeGlobs().fault`, and passes `allowEmpty: true` so the tier is a clean no-op when nothing matches. It is non-gating and runs on a `[chaos]` commit or a schedule. The specs import the AI modules from `../../src`, so a chaos run still measures source. The plan's Wave 2 adds specs into this tier; it does not build a new harness.

The **hand-rolled fault harness** those specs use is already proven by `tests/@integration/fault_injection/tool_audit_db_down_action_fail_closed.spec.ts`. Its idioms are the ones every Wave-2 spec reuses: a per-run schema suffix (`const suffix = randomUUID().replace(/-/g, '').slice(0, 12)`, `ai_audit_fault_${suffix}`) so parallel runs never collide; a private connection registered on that schema (`db.manager.add(CONN, { ...template, searchPath: [SCHEMA] })`) and released in the group teardown; an `AsyncLocalStorage<string>` (`const als = new AsyncLocalStorage<string>()`) standing in for `tenancy.run` / `tenancy.currentId` so the spec drives the real loop without the full HTTP tenancy stack; a readiness probe in `group.setup` that does `SELECT 1` and sets a `ready` flag; and every test gated `.skip(() => !ready, 'Postgres unavailable')` so the tier self-skips with no infra. The fault is injected at a real seam (there, the `AiToolAuditSink.append` throws the exact typed `AIException('audit_write_failed')` the production `PgToolAuditSink` chain throws) and asserted with a **counter** (`auditAttempts`) that pins the fault to what the spec injected rather than to an incidental failure. Wave 2's six specs are cut from this same cloth.

The **anti-drift coverage matrix**, `tests/@architecture/docs/ai_threat_vector_coverage_matrix.spec.ts`, pins each of the 18 threat vectors to covering specs on disk. Its fs-existence loop (lines 194 through 208) turns a renamed or deleted covering spec into a hard red gate, and its null-slot loop (lines 210 through 219) forces an honest-limit `reason` on any uncovered slot. Today `VectorCoverage.chaosSpec` is `string | null` (one chaos spec per vector). Wave 2 changes exactly that field.

## 2. The wave ordering, and why it is the only sane order

Six waves, each an independent PR, each red-first, each committed as `arcoders` with no Co-Authored-By trailer, each gated by `npm run check` plus `npm run typecheck` (after `npm run build:all`) plus eslint and prettier, keeping the guarantee-tree and threat-vector-matrix guards green. Details of the mechanisms are in `02` through `05`; this is the sequencing and why.

| Wave | Scope | Depends on | Behavior change |
|---|---|---|---|
| 0 | Type and error foundation: compile-forced retryability, the `#runStream` split, typed Redis seams | none | none (proven by existing specs staying green) |
| 1 | Resilience foundation: one policy seam over every request-path Redis read, a DB-outage classifier at the vector-store boundary, unmetered-spend fail-closed at boot | 0 | yes (dissolves two latent 500s) |
| 2 | Chaos tier expansion: six new fault specs, matrix carries multiple specs per vector | 0, 1 | none (verification only) |
| 3 | Injection seam: the structural boundary made observable, plus a pluggable `InjectionClassifier` | 0 | additive |
| 4 | Audit consumption: read/query, export, checkpoint verify, retention, anomaly, the `ai` actor correction | 0 | additive |
| 5 | Data-at-rest, gated: per-tenant memory DEK, embeddings content-at-rest, both default-off | 0, 1 | none by default |

The ordering is foundation-first and it is not cosmetic. Waves 0 and 1 come first because they **dissolve the two latent bugs** that a naive pass would patch with a local `try/catch` (an idempotency-lookup Redis outage 500ing the request, a vector-store DB outage surfacing as an opaque 500), and because they lay the exact resilience contract that Wave 2's chaos tier is written to verify. Verifying the chaos tier before the foundation exists would mean asserting the buggy behavior. Wave 0 is a strict prerequisite of everything downstream because it removes the one place the type system does not backstop correctness today: `FATAL_CODES` in `src/exceptions/ai_exception.ts:128` is a hand-maintained `ReadonlySet<AIErrorCode>` whose own comment (`ai_exception.ts:148`) documents the drift hazard, and `isRetryable()` (`ai_exception.ts:205`) reads it. After Wave 0 that Set becomes a total `RETRYABILITY` record keyed by the `AIErrorCode` union, so adding a code without classifying its retryability is a compile error, the same way adding one without a status already is. Wave 1's new typed `vector_store_unavailable` code (retryable, 503) is only safe to add once that totality is compiler-enforced. Waves 3 and 4 are largely independent of each other and of Wave 2; either can land first once 0 and 1 are in. Wave 5 is designed here and plumbed default-off; flipping any host on is a separate go (`00-foundation.md`, the `05` doc).

## 3. Wave 2 in detail: six fault specs and a matrix that carries them

The chaos tier today exercises only the tool loop. Wave 2 adds six specs under `tests/@integration/fault_injection/`, each reusing the harness idioms in section 1 (per-run schema suffix, `AsyncLocalStorage` for the tenancy scope, `SELECT 1` readiness gate, `.skip(() => !ready)`, counter assertions), each injecting one real mid-flight fault at a real seam and asserting the Wave-1 typed outcome rather than a 500.

| # | New spec (proposed name) | Fault injected | Green condition |
|---|---|---|---|
| 1 | `resilience_provider_429_5xx_real_spine.spec.ts` | provider returns 429 / 5xx on the real streaming spine | surfaces as the typed retryable code with its pinned status, `isRetryable()` true, no partial-spend leak |
| 2 | `resilience_provider_timeout_real_spine.spec.ts` | provider stalls past the per-request deadline | typed timeout, reservation released in the fail-open `finally`, no wedged loop |
| 3 | `resilience_chat_socket_drop_mid_stream.spec.ts` | client drops mid-stream on a PLAIN (non-tool) chat | the liveness watcher aborts the run, no orphaned provider stream, settle runs |
| 4 | `resilience_redis_outage_memory_and_idempotency_fail_open.spec.ts` | Redis down mid memory-read AND mid idempotency-lookup | the Wave-1 policy-driven fail-open returns a MISS and the request proceeds, NOT a 500 |
| 5 | `resilience_vector_store_outage_typed_503.spec.ts` | vector-store DB outage during retrieval | the Wave-1 boundary classifies it as the typed retryable `vector_store_unavailable` (503), NOT an opaque 500 |
| 6 | `resilience_malformed_chat_sse_wire_parser.spec.ts` | malformed SSE frames fed through the real wire parsers | the parser rejects cleanly with a typed error, no crash, no half-parsed fragment leaks downstream |

Specs 4 and 5 are the ones that PROVE the two latent bugs are dissolved at the root: spec 4 asserts that an idempotency-backend outage is a fail-open MISS (the policy the Wave-1 seam attaches, not a per-caller catch), and spec 5 asserts that a transport outage in the vector store funnels through one boundary that emits `vector_store_unavailable` (absent from `src/constants.ts` today, added by Wave 1, retryable by the Wave-0 totality, 503 by its pinned status). These two are the acceptance evidence for `02`, exercised against the real wire rather than a fake.

The matrix change is the second half of Wave 2. `VectorCoverage.chaosSpec` moves from `string | null` to `Array<string>` (empty array meaning "no chaos spec", which then requires the same honest-limit `reason` a `null` requires today). Three edits follow from that type change:

1. The fs-existence loop (`ai_threat_vector_coverage_matrix.spec.ts:194`) iterates `[row.redSpec, ...row.chaosSpec]` instead of `[row.redSpec, row.chaosSpec]`, so every path in the array must exist on disk.
2. The null-reason loop (`:210`) tests `row.chaosSpec.length === 0` (with `redSpec === null`) instead of `chaosSpec === null`, so an empty chaos array still demands a `reason`.
3. The six new specs are registered by appending their repo-relative paths to the `chaosSpec` array of the vectors they cover (for example spec 5 joins vector 18's array, spec 4 joins vectors 1 and 5, spec 3 joins vector 8). A vector that legitimately has no chaos spec (vectors 9 and 17 today) keeps its `reason` and carries an empty array.

The matrix's first two guards (18 entries, every mapped spec exists) stay green through the change; that is the anti-drift proof that the type migration did not silently drop a covering spec.

## 4. Per-wave acceptance tests

Each wave lands red-first: a spec that fails stating the gap, then the fix that turns it green. The tables below give the red condition and the green condition per wave. "Stays green" rows are the behavior-preserving proof for Wave 0 (per `00-foundation.md` section 1: a behavior-preserving refactor is proven by existing regressions staying green, not by new assertions restating the refactor).

### Wave 0: type and error foundation (no behavior change)

| Spec | Red before | Green after |
|---|---|---|
| `behavior_ai_exception.spec.ts` (existing) | n/a | stays green: `httpStatus` and `isRetryable()` unchanged for every existing code |
| `resilience_stream_extension.spec.ts` (existing) | n/a | stays green: the `#runStream` split preserves the streaming contract |
| retryability-totality type test (new) | a code union member with no `RETRYABILITY` entry compiles | the `RETRYABILITY` record is total over `AIErrorCode`; a missing entry is a compile error (the `FATAL_CODES` Set drift at `ai_exception.ts:148` is gone) |

### Wave 1: resilience foundation

| Spec | Red before | Green after |
|---|---|---|
| idempotency-outage (unit) | a Redis outage during idempotency lookup 500s the request | returns a MISS and proceeds (fail-open policy on the seam) |
| vector-outage (unit) | a vector-store DB outage surfaces as an opaque 500 | returns the typed `vector_store_unavailable` (retryable, 503) |
| unbudgeted-boot (unit) | an unmetered `aiTokens` quota only warns at boot | boot aborts fail-closed unless the existing `acknowledge` escape hatch is set |

### Wave 2: chaos tier expansion

The six specs of section 3, each `.skip(() => !ready)`, each asserting a typed outcome and a counter, plus the matrix migration guards staying green.

### Wave 3: injection seam

| Spec | Red before | Green after |
|---|---|---|
| structural-boundary observability | the structural role separation is silent (no signal) | the boundary emits its observable signal; cross-tenant leakage remains 0 by construction (I4) |
| classifier-off leakage | n/a | with the classifier disabled, measured leakage is still 0 (the seam is not the boundary) |
| classifier block | a semantic hit has no defined disposition | a block returns a pinned 400 plus a `failed_preflight` audit row plus ZERO spend (reject before any reservation) |

### Wave 4: audit consumption

| Spec | Red before | Green after |
|---|---|---|
| reader scope | no read API | the reader returns only tenant-scoped rows (the re-assert-before-raw-SQL rule of the baseline) |
| export order | no export | export re-walks the chain and emits rows in chain (`seq`) order, NDJSON/CSV |
| checkpoint verify | verify re-walks the whole chain each time | incremental verify from a checkpoint does NOT mutate the chain (no `prev_checksum` rewrite) |
| anomaly | no alerting | an anomaly fires off the guard bus when a threshold is crossed |

### Wave 5: data-at-rest (gated, default-off)

| Spec | Red before | Green after |
|---|---|---|
| default-off parity | n/a | with the feature default-off, behavior reproduces today's byte-for-byte (the plumbing is inert) |
| tenant-dek path | no per-tenant memory key | the `tenant-dek` path seals and opens memory under a per-tenant DEK |
| shred | no crypto-erase | shredding the tenant DEK makes that tenant's memory irrecoverable |

## 5. Verification recipe against the real stack

Run in this order. Every command is a real invocation; none is a simulation. Never read a gate's result through `| tail` (a truncated gate is a green-looking gate that failed upstream).

**Unit** (fast, source-direct, no build):

```bash
cd packages/ai && npx tsx bin/test.ts
```

**Integration** (builds first, real Postgres and Redis, runs against `./build`):

```bash
npm run test:integration:run --workspace @adonisjs-lasagna/ai
```

**Chaos** (the Wave-2 tier; self-skips cleanly with no infra because every spec is `.skip(() => !ready)` and the suite runs `allowEmpty: true`):

```bash
cd packages/ai && npx tsx --tsconfig ../../tsconfig.json bin/test.fault.ts
```

**Guards, types, lint** (the gate the discipline in `00-foundation.md` section 4 requires):

```bash
npm run check
npm run build:all && npm run typecheck
npx eslint packages/ai/src packages/ai/tests
npx prettier --check "packages/ai/**/*.ts"
```

`npm run check` carries the source-scan guards a wave must keep green: `no_silent_ai_guard`, `check-ai-invariant-4` / `-5`, `check-no-hardcoded-backoffice`, and the guarantee-tree / threat-vector-matrix specs. The typecheck must run after `build:all` because satellites and the demo resolve `build/*.d.ts`.

**End-to-end drive** (mandatory for the request-path waves: 1, 3, and the read/export half of 4). Drive the rental "Karimoto" app with real DeepSeek on port `:3334`, launched from the canonical `C:\` drive letter (a lowercase drive letter crashes AdonisJS boot in the logger; see the memory note). The drive confirms the mechanism over real HTTP, not just in-process:

- **Wave 1**: pull Redis and confirm a chat request DEGRADES (fail-open MISS, 200) rather than 500; pull the vector store and confirm retrieval returns the typed retryable 503, not an opaque 500.
- **Wave 3**: send a request the classifier blocks and confirm a pinned 400 plus a `failed_preflight` audit row plus ZERO spend on the cost governor.
- **Wave 4**: read and export audit rows and confirm they are tenant-scoped and in chain order.

The end-to-end drive is the acceptance evidence a review trusts, because the six Wave-2 chaos specs and the unit specs both run in-process with `AsyncLocalStorage` standing in for tenancy; the drive is the one place the full HTTP tenancy stack, the real provider wire, and the real Redis/PG/vector backends all participate at once.

## 6. Success metrics

The bundle succeeds when four measurable things hold, each tied to an observable this plan ships, none to a subjective "feels hardened":

1. **Leakage held at 0 by construction.** Wave 3's classifier-off leakage spec and the existing cross-tenant fuzz keep measured cross-tenant leakage at 0 whether or not the optional semantic seam is wired. The number is 0 because foreign data is never in context (I4), not because a detector caught it.
2. **Chaos coverage per vector is auditable and grew.** The matrix now carries an ARRAY of chaos specs per vector, the six new specs are registered, and the fs-existence guard proves every registered spec exists on disk. The metric is: which fault is injected for which vector, readable straight off `ai_threat_vector_coverage_matrix.spec.ts`.
3. **The denial-of-wallet rails are provably non-inert.** Wave 3's block-path spec asserts ZERO spend on a rejected request, and Wave 2 spec 2 asserts the reservation is released on a provider timeout. The rails are exercised under fault, not just asserted to exist.
4. **Audit consumption surfaces shipped.** Read, export in chain order, non-mutating checkpoint verify, retention, and anomaly alerting are all present and tenant-scoped, closing the "bulletproof to write, nothing to read" gap ranked in `01`.

## Honesty bound

This is a plan, and a plan's guarantees are bounded by what its tests actually exercise.

- The chaos tier is **non-gating and self-skipping**. When Postgres or Redis is absent every Wave-2 spec skips via `.skip(() => !ready)` and the suite passes empty (`allowEmpty: true`). A green chaos run on a machine with no infra proves NOTHING about resilience; the metric in section 6 only counts a run where `ready` was true. CI must assert the tier actually executed, not merely that it exited 0.
- The end-to-end drive is a **manual, single-operator** confirmation on one app (Karimoto) with one real provider (DeepSeek). It demonstrates the mechanism works over real HTTP once; it is not a continuous regression and it does not sweep every provider or every tenant configuration.
- The six Wave-2 specs assert the TYPED outcome of an injected fault. They do not prove the absence of every other fault path; they prove that the specific faults enumerated in `01` produce a typed degrade instead of a 500. A fault this plan did not enumerate is not covered until a spec for it joins the matrix.
- The matrix guarantees a covering spec EXISTS on disk for each mapped vector. It does not verify the spec is meaningful: a registered path that points at a spec asserting nothing would still pass the fs-existence guard. The `no_silent_ai_guard` and emission-matrix guards backstop the guard side, but the coverage matrix itself is an existence check, not a quality check.
- Success metric 1 ("leakage 0 by construction") is a claim about the STRUCTURAL boundary (role separation plus I4). It is not a claim that the optional Wave-3 semantic classifier catches anything; that seam is explicitly not the boundary (`00-foundation.md` section 5).

## Open decisions owned by the user

1. **Wave ordering past the foundation.** Recommended default: `0 -> 1 -> 2 -> 3 -> 4 -> 5`, exactly as executed. Waves 0 and 1 are non-negotiably first (they dissolve the latent bugs and underpin the chaos tier the plan verifies). Waves 3 and 4 are largely independent and may swap if a business reason favors audit consumption before the injection seam. Wave 5 stays last and gated.
2. **Whether the chaos tier becomes gating.** Recommended default: keep it non-gating on the PR path (real infra makes it slow and hostile) and run it on a `[chaos]` commit or schedule, but add a CI assertion that a scheduled run had `ready === true` so a silently-skipped tier cannot read as green. The alternative (make it gate every PR) buys stronger signal at the cost of every PR depending on live PG and Redis.
3. **Whether the end-to-end drive is automated.** Recommended default: keep it a documented manual drive for the request-path waves (it is the honest cross-stack confirmation and automating a real-provider HTTP drive is brittle and costs real DeepSeek spend). The alternative is a scripted e2e under `examples/api/tests/@integration/e2e/ai/` using a mock provider, which automates the shape but loses the real-wire fidelity that made the drive worth doing.
4. **The Wave-2 spec names.** The six names in section 3 are proposals. Recommended default: adopt them as written so the matrix registration and the file paths agree in one PR; the only hard constraint is the `<guarantee>_<context>_<outcome>.spec.ts` convention and that each registered path exists on disk (the matrix guard enforces the latter regardless of the name chosen).
