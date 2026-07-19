# 02 Resilience foundation (Waves 0 and 1)

This is the first pair of implementation waves and the one the rest of the bundle stands on. Wave 0 is
pure type and error-space work with no runtime behavior change: it makes retryability compile-forced,
splits the one stream hotspot into named blocks proven equivalent by an existing spec, and gives the
three `Promise<any>` Redis seams a real structural type. Wave 1 is the resilience foundation: one
policy seam over every request-path Redis read, a database-outage classifier at the vector-store
boundary, and the unmetered-`aiTokens` posture promoted from a boot warning to a fail-closed boot
abort. The two "latent 500 bugs" named in `01-threat-model.md` (an idempotency-lookup Redis outage
500ing a request, a vector-store DB outage surfacing as an opaque 500) are DISSOLVED at the root here,
not patched with a per-caller `catch`.

Everything below follows the discipline in `00-foundation.md` sections 1 and 4: seams and validated
config fields, never a silent local `try/catch`; fail posture set by an explicit policy on the seam,
never by whether a caller remembered to wrap a call; every bound a named constant in
`packages/ai/src/constants.ts`; schema and connection always the injected dependency.

## Wave 0: the type and error foundation (no behavior change)

### 0.1 Compile-force retryability

**What already ships.** Two parallel tables key off the closed `AIErrorCode` union
(`packages/ai/src/exceptions/ai_exception.ts:9-45`). `STATUS_BY_CODE`
(`ai_exception.ts:55-108`) is a `Record<AIErrorCode, number>`, so it is TOTAL by construction: adding
a code without giving it a status is a compile error, and `httpStatusForAiCode`
(`ai_exception.ts:118-120`) reads the total map. Retryability is the one classification the type system
does NOT backstop: `FATAL_CODES` (`ai_exception.ts:128-178`) is a hand-maintained
`ReadonlySet<AIErrorCode>`, and `isRetryable()` (`ai_exception.ts:205-207`) computes
`!FATAL_CODES.has(this.aiCode)` (a NEGATION over a partial set).

**The gap.** Because the set is partial, a code omitted from it is silently classified retryable. The
source itself documents the hazard twice. The `residency_denied` entry
(`ai_exception.ts:148-152`) carries "`FATAL_CODES` is a plain Set (NOT compile-forced by the union),
so this entry is added by hand… a missing entry here would wrongly make it retryable (a client would
retry the very egress residency exists to block)". The `tool_confirmation_invalid` entry
(`ai_exception.ts:164-171`) spells out the sharpest case: it sits adjacent to
`tool_action_unavailable`, which is the OPPOSITE classification (the ledger is down, retrying once it
recovers is correct), "Two adjacent codes, opposite classifications, in a Set the compiler does not
check: pinned by a spec for that reason." The default-retryable posture means the failure mode of
forgetting a code is the DANGEROUS direction: a fatal refusal (a forged confirmation MAC, a residency
block) reads as retryable and invites a client to hammer a mutation or a denied egress.

**Root-cause mitigation.** Replace the partial `ReadonlySet` with a total map, exactly the shape
`STATUS_BY_CODE` already uses:

```ts
const RETRYABILITY: Record<AIErrorCode, 'fatal' | 'retryable'> = {
  provider_unavailable: 'retryable',
  provider_not_allowed: 'fatal',
  over_budget: 'fatal',
  rate_limited: 'retryable',
  rate_limit_unavailable: 'retryable',
  // …every code classified, exhaustively…
  tool_confirmation_invalid: 'fatal',
  tool_action_unavailable: 'retryable',
}
```

`isRetryable()` becomes `return RETRYABILITY[this.aiCode] === 'retryable'`, a POSITIVE read of a total
map rather than a negation over a partial set. **Fail posture: compile-closed.** After this change,
adding an `AIErrorCode` without classifying its retryability is a TypeScript error, the same way adding
one without a status already is, so the classification cannot drift. This deletes both drift-risk
comments (`ai_exception.ts:148-152` and `ai_exception.ts:164-171`): they exist only to compensate for
the missing compile check, and once the compiler enforces totality they are dead weight. The
`StreamPreflightError` doc that references `FATAL_CODES` by name (`stream_extension.ts:119`) is updated
to name `RETRYABILITY`.

**Guard/metric.** None needed. The compiler IS the guard; this is the point of the change. The
existing `ai_threat_vector_coverage_matrix.spec.ts` and the retryability assertions stay green.

**Acceptance tests.** `behavior_ai_exception.spec.ts` stays green UNMODIFIED (it asserts the actual
fatal/retryable verdict per code, which the migration preserves value-for-value; a green run is the
proof of behavior preservation, per `00-foundation.md` section 1). A red-first addition removes one
code from the union in a type-only fixture and asserts the package no longer typechecks, pinning that
totality is now compile-enforced.

### 0.2 Extract `#runStream` into named, single-purpose blocks

**What already ships.** `StreamExtensionService.#runStream` (`stream_extension.ts:242-384`) is a single
~143-line method that does five things in sequence: pre-flight breaker + reserve
(`stream_extension.ts:247-262`), collaborator + four-way abort setup (`stream_extension.ts:264-289`),
the pump loop inside `runExtension` (`stream_extension.ts:291-335`), the caught-error classifier
(`stream_extension.ts:336-354`), and the fail-open settle+release `finally`
(`stream_extension.ts:355-371`). It is correct and well-commented, but it is the satellite's single
largest method and the hardest place to change safely.

**The gap.** This is a maintainability gap, not a runtime bug. The method's length makes the
commit-point invariant (nothing throws to the caller after `commit()` flushes headers) hard to verify
at a glance, and it is the exact hotspot Wave 2's chaos tier will inject faults into. A reader cannot
audit the five phases independently.

**Root-cause mitigation.** Extract behavior-preservingly into four private methods with intention
names: `#preflight` (breaker + reserve, returns either a reservation or a `failed_preflight`),
`#pump` (the `runExtension` fragment loop), `#classifyCaught` (the `catch` block's
committed/timeout/mid-stream branching), and `#settleAndRelease` (the `finally`). **Fail posture:
unchanged by construction.** This is a pure refactor; no policy moves.

The REAL risk, and the reason this is a Wave-0 line item rather than a throwaway cleanup, is that the
five blocks are NOT independent: they share a wall of outer-scope mutable locals that the pump and the
catch both read and write. `reason` and `preflightError` (`stream_extension.ts:288-289`) are set inside
the pump loop AND the catch and read by the final return (`stream_extension.ts:373-383`); `committed`
(`stream_extension.ts:273`) is flipped by the `commit()` closure and read by the catch to decide
pre-commit versus mid-stream; `reservation` (`stream_extension.ts:257`), `pipeline`
(`stream_extension.ts:266`), `writer`, `disconnect`, `budget`, `composed`, and `heartbeat` are all
threaded through pump, catch, and finally. A naive extraction that turned these into parameters and
return values would be error-prone precisely where correctness matters most. The mitigation is to
thread them explicitly through a small mutable state object (a `StreamRunState` holding
`reason`/`preflightError`/`committed`/`reservation`/`pipeline` plus the collaborators), passed by
reference to each block, so the shared-mutation contract is visible in one type instead of implicit in
a closure's scope.

**Guard/metric.** None. The regression spec IS the control.

**Acceptance tests.** `resilience_stream_extension.spec.ts` is the regression guard and stays green
UNMODIFIED. Per `00-foundation.md` section 1, a behavior-preserving refactor is proven by its existing
regression spec staying green, not by new assertions that merely restate the refactor. No new
behavioral spec is added for the split itself.

### 0.3 Type the three Redis seams

**What already ships.** Three services take Redis as an injected accessor typed `() => Promise<any>`,
so they never value-import the eager core `/services` barrel (which top-level-`await`s `app.booted`
and breaks the bare AI unit runner): `ConversationMemoryDeps.getRedis`
(`conversation_memory_service.ts:82`), `AiComplianceDeps.getRedis`
(`ai_compliance_service.ts:82`), and `AiComplianceCheckDeps.getRedis`
(`ai_compliance_check.ts:7`). The injection pattern is right; the `any` is the weak point.

**The gap.** `Promise<any>` means every Redis call site is unchecked. A typo in a command name, a wrong
argument arity, or a misremembered ioredis return shape compiles clean and fails only at runtime. The
three sites also rely on DIVERGENT inline shapes, so no single site documents what "Redis" must
provide: memory uses `pipeline().rpush().ltrim().pexpire().exec()`
(`conversation_memory_service.ts:271-276`), `lrange` (`conversation_memory_service.ts:204`), `scan`
with `MATCH`/`COUNT` (`conversation_memory_service.ts:378`), `del`
(`conversation_memory_service.ts:293`), `set` with `PX` (`conversation_memory_service.ts:405`), and an
optional `unlink` (`conversation_memory_service.ts:475`); the compliance service uses `set` with
`NX`/`PX` and `del` for its purge lock (`ai_compliance_service.ts:381-394`); the compliance check uses
`ping()` and reads `options.keyPrefix` (`ai_compliance_check.ts:27-42`).

**Root-cause mitigation.** Add `packages/ai/src/services/redis_seam.ts` exporting a structural
`AiRedisLike` interface that is the UNION of exactly the members these three sites use, and replace the
three `Promise<any>` return types with `Promise<AiRedisLike>`:

```ts
export interface AiRedisPipeline {
  rpush(key: string, ...values: string[]): AiRedisPipeline
  ltrim(key: string, start: number, stop: number): AiRedisPipeline
  pexpire(key: string, ms: number): AiRedisPipeline
  exec(): Promise<Array<[Error | null, unknown]> | null>
}
export interface AiRedisLike {
  lrange(key: string, start: number, stop: number): Promise<unknown[]>
  pipeline(): AiRedisPipeline
  scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>
  del(...keys: string[]): Promise<number>
  unlink?: (...keys: string[]) => Promise<number>
  ping(): Promise<unknown>
  readonly options?: { readonly keyPrefix?: unknown }
}
```

**Fail posture: unchanged (compile-only).** The type is deliberately structural (the real `@adonisjs/redis`
`Connection` satisfies it without an `implements`), and `exec()` returns the `[Error | null, unknown][]`
tuple shape the memory service already inspects (`conversation_memory_service.ts:277-282`), so the
existing per-command error handling now typechecks instead of leaning on `any`. `unlink` stays optional
because the code already feature-detects it (`conversation_memory_service.ts:475`). The seam lives in
`packages/ai`, imports nothing from core, and keeps the bare-unit-runner property intact.

**Acceptance tests.** No new spec; the whole point is that this compiles or it does not.
`npm run typecheck` (after `npm run build:all`) is the gate, and the existing memory/compliance unit
suites stay green against their fakes (the fakes now have to satisfy `AiRedisLike`, which is a stricter
and therefore better test double).

## Wave 1: the resilience foundation (root fix, dissolves both latent bugs)

### 1.1 One resilience-policy seam over every request-path Redis read

**What already ships.** Core already owns the right abstraction: `ResilienceService.run()`
(`packages/core/src/services/resilience_service.ts:50`) takes a `ResilienceRunOptions<T>`
(`resilience_service.ts:17-30`) naming a `dependency`, an `operation` label, a `FailurePolicy`
(`packages/core/src/types/config.ts:341`, `'fail-open' | 'fail-closed'`), a typed `fallback()`, and the
guarded `run()`. On `fail-open` it swallows and returns `fallback()`
(`resilience_service.ts:55-56`); on `fail-closed` it throws `DependencyUnavailableException`
(`resilience_service.ts:58-62`, a 503 with Retry-After); either way it logs, annotates the active span,
and dispatches a `DependencyDegraded` event (`resilience_service.ts:66-109`). It is exported from
`@adonisjs-lasagna/saas-tenancy/services` (`packages/core/src/services/index.ts:15`). The three AI
Redis reads today do NOT use it: each hand-rolls its own posture in an ad-hoc `try/catch`.

**The gap.** The three postures are correct but they are UNSHARED and INVISIBLE, which is how the latent
bug hides. Memory `load()` fails open to `[]` (`conversation_memory_service.ts:200-209`): a store
outage degrades the chat to no history, which is right. The rate limiter `check()` fails closed
(`ai_rate_limiter.ts:73-98`): a backend outage throws `rate_limit_unavailable` 503
(`ai_rate_limiter.ts:81-86`), which is right because an AI cost surface must not run unmetered when the
limiter is blind. Idempotency `lookup()` returns `null` on any doubt
(`packages/ai/src/gateway/idempotency.ts:156-166`): the `catch` at `idempotency.ts:163-165` degrades a
store outage to "no replay", which is right per the module's fail-open-toward-no-replay contract
(`idempotency.ts:18-24`). But NONE of this is a policy: it is three independent authors each remembering
to wrap a call, with no shared choke, no telemetry, and no config surface. The idempotency-lookup-500
"bug" is precisely the shape of a future author adding a read path and forgetting the `catch`.

**Root-cause mitigation.** Inject a `runResilient` closure into each of the three services, bound at
provider wiring to `ResilienceService.run`, the SAME injection discipline `getRedis` already uses so no
AI module value-imports the eager core barrel. Route all three reads through it with distinct operation
labels, PRESERVING each posture exactly:

| Read | `operation` label | Policy | `fallback()` / on-fail |
|---|---|---|---|
| memory `load` | `AI_RESILIENCE_OP_MEMORY_LOAD` | `fail-open` | `[]` (then existing metric + warn) |
| idempotency `lookup` / `save` | `AI_RESILIENCE_OP_IDEMPOTENCY_LOOKUP` / `_SAVE` | `fail-open` | `null` / skip |
| rate-limit `consume` | `AI_RESILIENCE_OP_RATE_LIMIT` | `fail-closed` | throws (see below) |

Crucially, the closure wraps ONLY the store operation, never the pure logic around it. Memory `load`
wraps only `redis.lrange` (`conversation_memory_service.ts:204`); the decrypt/decode loop and its
`AI_MEMORY_UNDECRYPTABLE_METRIC` emission (`conversation_memory_service.ts:214-234`) stay OUTSIDE the
resilience boundary, because a corrupt-blob drop is a data event, not a dependency outage, and must not
be conflated with one. Idempotency `lookup` wraps only `#currentEpoch`'s `store.get` and the entry
`store.get` (`idempotency.ts:158-160`); `parseCachedResponse` (`idempotency.ts:162`, `230-249`) stays
outside, so a corrupt cached JSON remains a plain miss (`null`) and never rides the resilience path. The
rate-limit closure wraps only the injected `consume` (`ai_rate_limiter.ts:80`); the `count > limit`
comparison and its `guard.ai_rate_limited` trip (`ai_rate_limiter.ts:88-97`) are a DOMAIN decision and
stay outside `run()`, per the `ResilienceRunOptions.run` contract that business throws (like
`QuotaExceeded`) must not reach it (`resilience_service.ts:27-29`).

**Fail posture, stated explicitly.** Memory and idempotency are `fail-open` because a lost history or a
skipped replay degrades gracefully and bounded by a TTL; availability wins. Rate-limit is `fail-closed`
because a blind cost limiter that passes is a denial-of-wallet hole; safety wins. The rate limiter keeps
its typed AI code: its `run()` wraps only the `consume`, and `ResilienceService` throws
`DependencyUnavailableException` (code `E_DEPENDENCY_UNAVAILABLE`) which the limiter maps back to
`AIException('rate_limit_unavailable')` so the AI code space stays total, mirroring the existing
`E_DEPENDENCY_UNAVAILABLE -> rate_limit_unavailable` mapping in `classifyReserveError`
(`stream_extension.ts:391`).

**How the idempotency-lookup-500 bug is DISSOLVED.** After this wave, fail-open is the POLICY attached
to the seam, not a `catch` a caller must remember. A store outage on the idempotency read resolves to
`null` (no replay, stream runs normally) because the policy says so, and it emits a `DependencyDegraded`
event and a span annotation for free. There is no per-caller error map to forget, and a future read path
that routes through `runResilient` inherits the posture. The bug cannot recur because the mechanism that
would prevent it is now structural.

**Where the policy lives (seam, not core change).** The policy is satellite-owned via a validated
`config.ai.resilience` block, so NO core change is needed for the policy home. It is a nested optional
object mirroring `AIAuditConfig` (`packages/ai/src/define_config.ts:167-174`), with per-operation
override and defaults that reproduce today's semantics exactly:

```ts
export interface AIResilienceConfig {
  /** Conversation-memory read. Default fail-open (a lost history degrades gracefully). */
  memory?: { policy?: FailurePolicy }
  /** Idempotency lookup/save. Default fail-open (a skipped replay is safe). */
  idempotency?: { policy?: FailurePolicy }
  /** Per-key rate-limit consume. Default fail-closed (a blind cost limiter must not pass). */
  rateLimit?: { policy?: FailurePolicy }
}
// on AiConfig, beside `audit?: AIAuditConfig`:
//   resilience?: AIResilienceConfig
```

Each field defaults to a named constant (below), so an absent block reproduces the current behavior
byte-for-byte. Validation routes through the single `fail()` choke in `validate_config.ts`
(`validate_config.ts:40-41`, which emits `guard.ai_config_invalid`), never a bare throw, per
`00-foundation.md` section 4.5: a `policy` that is neither `'fail-open'` nor `'fail-closed'` is a boot
`fail()`.

**New named constants** (`packages/ai/src/constants.ts`, never inline literals):

```ts
export const AI_RESILIENCE_DEPENDENCY_REDIS = 'redis'
export const DEFAULT_AI_RESILIENCE_MEMORY_POLICY: FailurePolicy = 'fail-open'
export const DEFAULT_AI_RESILIENCE_IDEMPOTENCY_POLICY: FailurePolicy = 'fail-open'
export const DEFAULT_AI_RESILIENCE_RATELIMIT_POLICY: FailurePolicy = 'fail-closed'
export const AI_RESILIENCE_OP_MEMORY_LOAD = 'ai.memory.load'
export const AI_RESILIENCE_OP_IDEMPOTENCY_LOOKUP = 'ai.idempotency.lookup'
export const AI_RESILIENCE_OP_IDEMPOTENCY_SAVE = 'ai.idempotency.save'
export const AI_RESILIENCE_OP_RATE_LIMIT = 'ai.rate_limit.consume'
```

**Guard/metric.** No new AI guard: an infrastructure outage is not a policy refusal of untrusted input
(the same reasoning the rate limiter already documents at `ai_rate_limiter.ts:83-85` for why an outage
does not ride `IsthmusGuardTripped`). Observability comes for free from `ResilienceService`'s existing
`DependencyDegraded` event and span annotation (`resilience_service.ts:78-105`), which is strictly more
than the three ad-hoc `catch` blocks emit today.

**Acceptance tests.** A red-first `resilience_redis_policy_seam.spec.ts` under
`tests/@guarantees/resilience/unit/` injects a `runResilient` whose `run()` throws a simulated Redis
outage and asserts: memory `load` resolves `[]`, idempotency `lookup` resolves `null`, and rate-limit
`check` throws `AIException('rate_limit_unavailable')` with status 503. A companion asserts a
`config.ai.resilience.idempotency.policy = 'fail-closed'` override flips the idempotency read to throw,
proving the policy is genuinely config-driven and not hardcoded. The existing memory, idempotency, and
rate-limiter unit suites stay green (posture is preserved by default).

### 1.2 Classify DB transport errors at the vector-store boundary

**What already ships.** Core owns the classifier: `isDependencyOutageError`
(`packages/core/src/utils/dependency_outage.ts:79`) returns true only for signatures that unambiguously
mean the Postgres connection or server is gone (socket errnos, `E_UNMANAGED_DB_CONNECTION`, SQLSTATE
class 08 / 57P0x / 53300, and a narrow message allowlist), and false for ordinary query errors like
constraint violations. Its own doc (`dependency_outage.ts:1-15`) frames it as the query-phase sibling
of the connect-phase mapping in `extensions/request.ts`. The vector store already funnels all placement
through one injected seam and satisfies a narrow `VectorQueryClient` interface with a single `rawQuery`
method (`packages/ai/src/services/vector_store_service.ts:15-18`).

**The gap.** `isDependencyOutageError` is NOT exported from core today: it is absent from the `exports`
map in `packages/core/package.json` (`package.json:37-58`), so the AI satellite cannot import it. And
the vector store runs twelve separate `rawQuery` calls with no shared outage boundary: five on the plain
client (`vector_store_service.ts:207`, `:224`, `:232`, `:242`, `:252`) and seven inside transactions
(`vector_store_service.ts:126`, `:132`, `:161`, `:171`, `:294`, `:297`, `:300`). If Postgres dies
mid-query, any of the twelve throws a raw driver error that surfaces to the caller as an opaque,
untyped 500. Every consumer (chat retrieval, ingestion, count, purge) would need its own `catch` and its
own error map to fix this locally, which is exactly the per-caller sprawl the governing direction
forbids.

**Root-cause mitigation, in two parts.**

First, a real (small) CORE change: export `isDependencyOutageError` through a public subpath. Add
`"./dependency-outage": "./build/src/utils/dependency_outage.js"` to both the `exports` map and the
`typesVersions` block in `packages/core/package.json` (both, per the CLAUDE.md rule that TypeScript
resolves declarations separately), OR re-export it from the existing `/internal` barrel. The recommended
home is `/internal` (it is a cross-satellite utility, not part of the host-facing 1.0 surface), matching
how the AI store already reaches core internals via `@adonisjs-lasagna/saas-tenancy/sdk`
(`vector_store_service.ts:3`). This is the only core edit in the two waves and it is additive.

Second, funnel EVERY raw query through one private `#exec` in the vector store:

```ts
async #exec(client: VectorQueryClient, sql: string, bindings?: readonly unknown[]): Promise<unknown> {
  try {
    return await client.rawQuery(sql, bindings)
  } catch (error) {
    if (isDependencyOutageError(error)) {
      throw new AIException('vector_store_unavailable', 'the vector store database is unavailable', {
        cause: error,
      })
    }
    throw error // an ordinary query error (constraint, cast) passes straight through
  }
}
```

Both the plain client and the in-transaction `trx` satisfy `VectorQueryClient`
(`vector_store_service.ts:15-18`), so `#exec` takes a `VectorQueryClient` and covers all twelve sites
(the advisory-lock and `SET LOCAL statement_timeout` queries inside `#batchedDelete` at
`vector_store_service.ts:294-300` included) with one boundary.

The new code `vector_store_unavailable` is added to `AI_ERROR_CODES` (`ai_exception.ts:9-45`), to
`STATUS_BY_CODE` as `503` (`ai_exception.ts:55-108`), and classified `'retryable'` in the Wave-0
`RETRYABILITY` map. This is where Wave 0 pays off: because `RETRYABILITY` is now TOTAL, you physically
cannot add the code without classifying it, so it lands `retryable` by compiler mandate rather than by
default-omission. `vector_store_unavailable` is absent from the fatal set precisely because a transport
outage becomes correct on a retry.

**Fail posture: fail-closed, retryable.** The vector read has no safe fallback (you cannot fabricate an
embedding search result, and a fail-open `[]` would silently degrade RAG to no-context without the
caller knowing), so unlike the Redis reads this boundary does NOT get a fail-open policy option: it
CLASSIFIES a transport outage into a typed retryable 503 and rethrows. A 503 tells the client the
condition is transient and retry is worthwhile; an opaque 500 tells it nothing.

**How the vector-outage-500 bug is DISSOLVED.** Every consumer already propagates a thrown `AIException`
unchanged (chat retrieval lets it surface pre-commit through `classifyProducerError`,
`stream_extension.ts:406-408; ingestion and the CLI purge let it bubble). None of them needs to know
about DB outages: the classification happens ONCE at the source, and the typed retryable error flows out
to every caller identically. There is no per-caller `catch` and no per-caller error map, which is the
whole point.

**Guard/metric.** No guard (a DB outage is not a policy refusal, consistent with 1.1). An optional
best-effort `AI_VECTOR_STORE_UNAVAILABLE_METRIC = 'ai_vector_store_unavailable'` emitted off the throw
path makes the outage visible on a dashboard, following the `AI_MEMORY_UNREADABLE_METRIC` precedent
(`conversation_memory_service.ts:104`).

**Acceptance tests.** A red-first `resilience_vector_store_outage.spec.ts` injects a `getDb` whose
`rawQuery` throws a fabricated `{ code: '57P01' }` (admin shutdown) and asserts every public method
(`insert`, `search`, `count`, `countByActor`, `countBySource`, `deleteBySource`, `purgeTenant`,
`deleteByActor`) throws `AIException('vector_store_unavailable')` with status 503 and
`isRetryable() === true`; a paired case throws a `{ code: '23505' }` (unique violation) and asserts it
passes through UNWRAPPED, proving `#exec` classifies transport outages only and never masks an
application error.

### 1.3 Unmetered `aiTokens` becomes a fail-closed boot abort

**What already ships.** `aiTokensBudgetPosture` (`packages/ai/src/services/ai_budget_check.ts:27-78`)
reads the static config and reports the `aiTokens` metering posture, from a static read alone. When a
fleet-wide operator ceiling is finite it returns `null` (healthy, `ai_budget_check.ts:33`); a per-plan
budget with no ceiling is `info` (`ai_budget_check.ts:41-49`); an acknowledged unbudgeted quota is
`info` (`ai_budget_check.ts:51-57`); a dynamic `getPlan` / `tenant_plans` store is `info`
(`ai_budget_check.ts:59-68`); and the provably-unbudgeted, unacknowledged, non-dynamic case is a
`warn` (`ai_budget_check.ts:70-77`). Boot consumes that posture and, for the `warn` case only, logs a
warning (`packages/ai/providers/ai_provider.ts:441-446`). The same posture drives the `ai_budget`
doctor check (`ai_budget_check.ts:87-100`).

**The gap.** A warning is a soft signal an operator can miss, and the `warn` case is the ONE case where
the code has PROVEN the reserve rail is inert: no per-plan budget, no operator ceiling, no acknowledge
flag, and no dynamic plan store, so the AI cost governor runs unmetered and the endpoint is a
denial-of-wallet target. Every other posture is `info` precisely because the code cannot be sure. Only
this case is safe to hard-fail, and `00-foundation.md` section 2 already commits to it: "Wave 1 turns
that boot-time warning into a fail-closed boot abort (with the existing acknowledge escape hatch
preserved)."

**Root-cause mitigation.** In the boot consumer (`ai_provider.ts:441-446`), convert the `warn` posture
from a `logger.warn` into a fail-closed boot abort. This is the SAME default-deny posture the membership
mount already uses: the mount gate refuses to mount AI routes without a membership gate unless
`acknowledgeNoMembershipGate === true` (`packages/ai/src/routes/mount_gate.ts:101-109`), and refuses
outright when `config.ai` is absent (`mount_gate.ts:92-99`). The unmetered-spend abort is the cost-rail
analogue: a provably inert cost governor is refused at boot with `config_missing` (an existing
`AIErrorCode`) routed through the `fail()` choke in `validate_config.ts`
(`validate_config.ts:40-41`), so it emits `guard.ai_config_invalid` and cannot drift from the throw. The
message reproduces the current warn text plus the two remedies the posture already names (budget it in
`config.plans`, or set `acknowledgeUnbudgetedAiTokens: true`, `ai_budget_check.ts:73-77`).

The escape hatch is PRESERVED unchanged: `config.ai.acknowledgeUnbudgetedAiTokens === true` already
routes to an `info` posture (`ai_budget_check.ts:51-57`), so an operator who has consciously accepted
unmetered spend never hits the abort, matching the paired-`acknowledge<X>` discipline of
`00-foundation.md` section 4.7. This is what keeps the abort fail-closed-with-a-visible-opt-out rather
than a hard wall.

**Fail posture: fail-closed at boot, and it must NEVER false-abort.** Only the `warn` posture aborts.
The dynamic-plan case (`ai_budget_check.ts:59-68`) and the operator-ceiling and per-plan cases stay
`info` and MUST keep booting: a host that budgets `aiTokens` through a dynamic `getPlan` or a
`tenant_plans` store is invisible to a static read (`ai_budget_check.ts:22-25` documents exactly this),
so hard-failing it would be a false positive that breaks a correctly-configured host. The whole design
of `aiTokensBudgetPosture` (info when the code cannot be sure, warn only when it has proven inertness) is
what makes it safe to promote just the `warn` branch to fail-closed. No posture classification changes;
only the consumer's reaction to the already-existing `warn` verdict changes.

**Guard/metric.** The boot abort emits `guard.ai_config_invalid` via `fail()`
(`validate_config.ts:40-41`). Optionally, a request-time `AI_UNMETERED_REQUEST_METRIC =
'ai_unmetered_request'` counter on the acknowledged-unmetered path makes a knowingly-unbudgeted
deployment observable on a dashboard (it booted because it acknowledged, so it should still be visible
that requests are running unmetered), following the observable-outcome discipline of
`00-foundation.md` section 4.6.

**Acceptance tests.** A red-first behavior spec constructs a config with `config.ai` present, no
`plans.operatorCeiling.aiTokens`, no per-plan `aiTokens` budget, no `getPlan`/`tenant_plans`, and no
`acknowledgeUnbudgetedAiTokens`, then asserts the boot consumer THROWS through `fail()` (emitting
`guard.ai_config_invalid`). A paired case adds `acknowledgeUnbudgetedAiTokens: true` and asserts boot
SUCCEEDS. Two false-abort guards assert boot succeeds for the dynamic-plan case
(`plans.getPlan` present) and the operator-ceiling case. The existing `ai_budget` doctor-check unit
suite stays green, since the posture function is unchanged.

## Honesty bound

- **Wave 0 changes no runtime behavior.** The retryability migration, the `#runStream` split, and the
  typed Redis seams are proven by EXISTING specs staying green. They remove drift RISK and unchecked
  `any`; they do not fix a live production incident, and the retryability verdicts are identical
  value-for-value before and after.
- **Fail-open memory and idempotency are a deliberate availability choice, not a free lunch.** Under a
  Redis outage, conversation memory silently degrades to no history and idempotent replay silently
  stops (a client retry re-runs the stream and can be charged twice). This is the RIGHT trade for those
  reads, but it means a Redis outage does have user-visible effects; it is bounded, not eliminated. The
  `DependencyDegraded` event is how an operator learns it happened.
- **The vector-store classifier only reclassifies what core's `isDependencyOutageError` recognizes.** A
  novel driver failure mode outside its narrow allowlist (`dependency_outage.ts:21-72`) still surfaces
  as a 500. The allowlist is deliberately conservative (better to under-classify an outage than to mask
  a real constraint violation as a retryable 503), so the honesty is: this covers the KNOWN transport
  signatures, not every conceivable DB failure. It also classifies the query phase; a connection-acquire
  failure at `transaction()` open is covered by the connect-phase mapping in `extensions/request.ts`,
  not by `#exec`.
- **The unmetered-spend abort only fires when the code has PROVEN inertness from static config.** A host
  that budgets through a dynamic store still boots without a static proof of metering, so this abort does
  NOT guarantee every deployment meters `aiTokens`; it guarantees a deployment that provably does not,
  and has not acknowledged that, fails loudly instead of quietly. The dynamic case remains the operator's
  responsibility, surfaced by the `ai_budget` doctor check at runtime.
- **None of these waves touch the tenant-isolation, audit-integrity, or SSRF controls** enumerated in
  `00-foundation.md` section 2. They are resilience and code-quality work; they preserve those
  guarantees, they do not extend them.

## Open decisions owned by the user

1. **Wave-1 resilience policy home (recommended default: satellite-owned `config.ai.resilience`).** Keep
   the policy in a validated `AIResilienceConfig` block on `config.ai` (nested like `AIAuditConfig`), so
   NO core change is needed for the policy home and the AI satellite owns its own postures. The
   alternative is adding AI-specific keys to the core `ResilienceConfig` (`packages/core/src/types/config.ts:352-362`),
   which couples the AI defaults into the kernel's config surface for no benefit. Recommendation:
   satellite-owned.
2. **Where `isDependencyOutageError` is exported from core (recommended default: `/internal`).** It is a
   cross-satellite utility, not part of the host-facing 1.0 surface, and the vector store already reaches
   core internals via `/sdk`. Re-export it from the `/internal` barrel rather than minting a new public
   `./dependency-outage` subpath that would then carry a 1.0 stability promise. The alternative (a
   dedicated public subpath) is available if a host is expected to classify DB outages directly.
   Recommendation: `/internal`.
3. **Whether to ship the optional metrics (recommended default: ship both).**
   `AI_VECTOR_STORE_UNAVAILABLE_METRIC` and `AI_UNMETERED_REQUEST_METRIC` are content-free integer
   counters that make a DB outage and a knowingly-unmetered deployment visible on a dashboard, at
   near-zero cost, consistent with the existing `ai_memory_*` metric family. The alternative is relying
   solely on the `DependencyDegraded` event and the boot abort. Recommendation: ship both.
4. **Whether a host may override rate-limit to `fail-open` (recommended default: allow it, but keep
   fail-closed the default and document the footgun).** The `config.ai.resilience.rateLimit.policy`
   field technically lets an operator flip the cost limiter to fail-open, which reopens the
   denial-of-wallet exposure the fail-closed default exists to close. The recommendation is to keep the
   override available for symmetry (an operator who has other cost controls may want it) but to leave the
   default fail-closed and state plainly in the docs that overriding it is accepting unmetered spend
   under a limiter outage. The stricter alternative is to forbid the override entirely in
   `validate_config.ts`. Recommendation: allow, default fail-closed, document.
