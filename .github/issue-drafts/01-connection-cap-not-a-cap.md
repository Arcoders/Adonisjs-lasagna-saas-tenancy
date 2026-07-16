# The tenant connection "cap" does not bound under the production grace window

**Labels:** `area/isolation`, `area/benchmarks`, `kind/correctness`, `priority/blocker-1.0`

> **Status: remedy implemented (opt-in).** Added `isolation.enforceConnectionCap`
> (default `false`). With `true`, the LRU stops exceeding the cap and `connect()` rejects a new
> connection with `TenantConnectionLimitException` (503) when everything is inside the grace window
> (hard cap / admission control). The default preserves the safe behavior of neither severing nor
> rejecting. Implementation: `connection_lru.ts` (`atHardLimit()`), `schema_pg_driver.ts` /
> `database_pg_driver.ts` (check in `connect()`), `types/config.ts`,
> `exceptions/tenant_connection_limit_exception.ts`; tests in `connection_lru.spec.ts`; the
> `connection_budget_burst` bench adds the `hardCapCheck` scenario. Still open: sizing
> `max_connections`/PgBouncer at scale and correcting the narrative in docs/report (done in
> `report.ts` and the readiness report).

## Summary

The performance report claims that "the connection cap holds up to 2000 tenants" and that "memory is
bounded by the cap, not by N". That conclusion is obtained by measuring the budget with the eviction
*grace window* artificially lowered to **50 ms**. With the production default grace of **30 s**, and
in the churn data from the same run, the open connections are **2×cap** (50/100/200), not the cap.
The LRU is **designed** to exceed the cap when all connections are inside the grace window, so under
a burst of N active tenants the connections trend toward N, with no ceiling other than Postgres's
`max_connections`.

The claim being sold ("bounded by the cap") is the opposite of what the system does under real load.

## Evidence (file:line)

- The budget bench forces grace to 50 ms so the cap "binds":
  `benchmarks/src/memory/connection_budget.bench.ts:24` (`BUDGET_GRACE_MS = 50`), with the comment
  at `:15-23` admitting that with the default grace "the pool grows to N".
- The real default is 30 s: `packages/core/src/services/isolation/connection_lru.ts:12`
  (`DEFAULT_EVICTION_GRACE_MS = 30_000`).
- The LRU exceeds the cap by design when everything is inside the grace window:
  `packages/core/src/services/isolation/connection_lru.ts:89-93` (does not evict; only warns).
- Counter-proof in the **same run** (default grace): the churn data records
  `tenantConnectionsOpen: 50 / 100 / 200` = 2×cap (caps 25/50/100). See the `connection_churn` meta
  in the results of run `2c3a6c7`.
- The report presents "open = 50 at N=2000" without disclosing the 50 ms grace:
  `benchmarks/results/PERFORMANCE_ASSESSMENT.md` (TL;DR and §4).
- The generated report bakes in the claim: `benchmarks/src/harness/report.ts:104` ("the connection cap
  holds as the tenant count grows") and `:219` ("open tenant connections stay bounded by the cap").

## Why it blocks 1.0

It leads to a dangerous configuration: an operator who sets the "cap" will believe their connections
are bounded to 50 and will size `max_connections` accordingly. Under a real burst of active tenants,
connections grow toward N, exhaust `max_connections`, and **take down every tenant** (not just the
one that triggered the burst). It is an availability failure at scale disguised as a guarantee.

## Acceptance criteria

- [ ] A benchmark exists that measures the number of open connections **with the default grace
      (30 s)** under a concurrent burst and publishes `openDuringBurst` (expected ≈ N, not the cap).
- [ ] A saturation scenario exists (`N×poolMax > max_connections`) that documents the failure mode
      and the recovery after draining (`failClosedCheck`, `recoveredWithinMs`).
- [ ] The generated report and `PERFORMANCE_ASSESSMENT.md` stop claiming "bounded by the cap" and
      explain the real model: "bounded by `max_connections`; use PgBouncer / admission control".
- [ ] The scaling-limits doc explicitly recommends PgBouncer (transaction pooling) above a certain
      number of concurrent tenants.

## Closing benchmark(s)

B-2 (budget with production grace + concurrent burst + `max_connections` failure mode).

## Fix options (with trade-offs)

1. **Document + measure honestly only** (this minimal issue): the core is untouched; the narrative is
   corrected and PgBouncer is recommended. Cheap; leaves the bounding responsibility to the operator.
2. **Optional hard cap / admission control in the LRU**: when the cap is reached and everything is in
   the grace window, *reject* (fail-closed with 503/Retry-After) or *queue* new tenant connections
   instead of exceeding the cap. Genuinely bounds memory/backends at the cost of rejecting new tenant
   traffic under a burst. Requires a core change (out of scope for this issue; open a follow-up).
3. **"Aggressive evict-LRU" mode**: reduce the grace or evict the least-recent even if it is inside
   the window. Risk: brings back the "sever an in-flight request" bug that the in-use-aware LRU fixed.
