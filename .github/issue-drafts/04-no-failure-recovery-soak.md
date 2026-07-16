# Zero soak / failure / recovery tests

**Labels:** `area/benchmarks`, `area/resilience`, `kind/gap`, `priority/blocker-1.0`

> **✅ RESOLVED (2026-06-07).** `bench:soak` (time series + `soakStableCheck` by RSS/backends slope)
> and `bench:resilience` (Redis/PG `docker stop/start` + failure policy + `recoveredWithinMs`)
> both exist. The rate-limit fail-open was fixed (see below). **Change from this session:** a
> Postgres outage on the tenant path now returns **503** (`DependencyUnavailableException`), not a
> raw 500: `request.tenant()` maps the outage to a fail-closed 503 and the resilience bench asserts
> it (`expectedStatus: 503`). `resilience` now runs on the weekly schedule (previously
> dispatch-only). Only pending: confirming the first green run on Linux CI.

## Summary

The benchmark only measures steady, happy state, in very short runs (HTTP = 10 s per scenario).
There are no long-duration (soak) tests, no fault injection (Redis down, Postgres at its connection
limit), and no recovery. The report acknowledges noise and `fsync=off`, but not the absence of
soak/failure, and still concludes "production-ready".

## Evidence (file:line)

- HTTP duration per scenario = 10 s (5 s in CI): `benchmarks/src/harness/config.ts:50`.
- No soak or resilience tier exists in `benchmarks/` (only micro/db/http/mem).
- Core failure policy worth asserting (today without a benchmark test):
  - rate-limit fail-closed by default → 503 if Redis goes down: `packages/core/src/middleware/rate_limit_middleware.ts:83-92`.
  - `ResilienceService` fail-closed → 503: `packages/core/src/services/resilience_service.ts:42-56`.

## Why it blocks 1.0

"Production-ready" with no evidence of behavior over hours/days or under dependency failure is an
unsupported claim. The real problems of a multi-tenant system (memory/fd leaks, backend growth,
degradation, behavior when Redis/PG go down) show up precisely in what is not measured.

## Acceptance criteria

- [ ] A soak mode (`bench:soak`) exists that runs the churn+HTTP workload for `BENCH_SOAK_HOURS`
      and records a time series of RSS/heap/external/pgBackends/fds.
- [ ] The soak emits `soakStableCheck`: FAIL if the RSS slope exceeds a sustained threshold or if
      `pgBackends` grows without a ceiling.
- [ ] A resilience mode (`bench:resilience`) exists that takes Redis and Postgres down (via `docker stop/start`)
      and asserts the real per-dependency failure policy + `recoveredWithinMs`.
- [ ] Redis down on the rate-limited path produces **503** (not a silent fail-open 200, not a hang),
      and recovers when Redis returns.
- [x] PG down on the tenant path returns a clean **503** (`DependencyUnavailableException`) and
      recovers when PG returns (previously: raw Lucid 500).

## ✅ Resilience-bench finding — rate-limit fail-open (FIXED)

> **Status: fixed.** Fix in `packages/core/src/middleware/rate_limit_middleware.ts`
> (detects null results / per-command errors / non-numeric zcard after `exec()` and
> applies the failure policy). Tests added in
> `packages/core/tests/unit/middleware/rate_limit_middleware.spec.ts`
> (resolved-with-errors → fail-closed by default; fail-open only with `failOpen:true`).
> The resilience bench now reports `503 / PASS` in the Redis-down scenario.

While implementing B-5 and running it with Redis down, the rate-limit **failed OPEN**: with Redis
unreachable (ECONNREFUSED confirmed), `GET /ratelimited/notes` returned **200**, not the documented
**503** (`failOpen=false` by default).

Root cause (`packages/core/src/middleware/rate_limit_middleware.ts:81-82`):

```js
const results = await pipeline.exec()
count = (results?.[2]?.[1] as number) ?? 0
```

`ioredis.pipeline().exec()` **resolves** with per-command `[error, result]` tuples instead of
**rejecting** when the backend fails. So the `try/catch` (line 83) never fires, `count` falls to
`0`, stays below the limit, and the request **is allowed**. `failOpen=false` never comes into play
on a Redis outage: the documented fail-closed policy is not honored.

Reproduction (before the fix): `BENCH_RESILIENCE=1 npm run bench:resilience` → `observedStatus: 200`,
`policyObserved: FAIL-OPEN`, `failPolicyCheck: FAIL`.

**Fix applied (core):** after `pipeline.exec()`, if the result is null, carries any per-command
error (`results.find(([err]) => err)`), or the `zcard` is not numeric, the error is thrown
→ the `catch` applies the policy (`failOpen` → `next()`; by default → `503`). This way the
documented fail-closed really holds on a Redis outage.

## Closing benchmark(s)

B-4 (soak with time series + `soakStableCheck`) and B-5 (fault injection + recovery,
which uncovered the fail-open above).

## Fix options (with trade-offs)

1. **Short scheduled soak in CI + long on-demand soak** (recommended): cheap continuous coverage
   plus the ability to run 24 h/7 d when needed.
2. **Resilience with manual containers in CI**: necessary because GitHub *service containers* cannot
   be controlled (`stop/start`) easily; adds complexity to the workflow.
3. **App-level fault injection (stubs)** instead of killing containers: more deterministic but less
   realistic; useful as a unit-level complement, not a substitute for the container e2e.
