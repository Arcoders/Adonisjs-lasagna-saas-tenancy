# No cross-tenant isolation test on the real path under concurrency

**Labels:** `area/isolation`, `area/benchmarks`, `kind/correctness`, `priority/blocker-1.0`, `security`

> **✅ RESOLVED (2026-06-07).** The concurrent HTTP isolation tier with content-based correlation
> (`benchmarks/http/isolation.bench.ts`) runs as a **per-PR gate** across all 3 drivers
> (`.github/workflows/benchmark-correctness.yml`), with a negative self-test (`BENCH_ISO_SELFTEST=1`)
> and a write-path assertion (`bench:db` write-isolation). The `rowscope-pg` limit (raw/unscoped
> query) is documented and backed by the RLS backstop
> (`packages/core/tests/integration/services/rowscope_rls.spec.ts`). It meets every criterion.
> The analysis below is the original one that motivated the work.

## Summary

The report calls "zero cross-tenant leaks" the most important correctness property. But the only
test backing it is **sequential**, runs **after** the churn, obtains the connection with an
**explicit** `ref`, and **never goes through the real resolution path** (HttpContext +
AsyncLocalStorage) that production uses. For `rowscope-pg` the test **injects the `where tenant_id`
predicate into itself**, so it only shows that `WHERE` filters, not that the driver/mixin isolates.
The HTTP tier, which does exercise the real path under concurrency, **has no isolation assertion at
all**: it only measures non-2xx and throughput.

In other words: the dangerous leak vector (ALS context crossing under concurrency, connection reuse
during an in-flight evict, mixin bypass via raw/relation/aggregate) is **untested**.

## Evidence (file:line)

- `countLeaks` is sequential, post-churn, with an explicit ref: `benchmarks/src/db/connection_churn.bench.ts:44-54`.
- The connection is obtained with an explicit ref via `clientFor` → `driver.connect(ref)`:
  `benchmarks/src/db/queries.ts:13-20`.
- The rowscope predicate is added by the verification query itself: `benchmarks/src/db/queries.ts:47-51`.
- The real resolution path (ALS + `HttpContext.get()`) the test never touches:
  `packages/core/src/models/adapters/tenant_adapter.ts:54-66`.
- The HTTP tier only checks non-2xx, not per-tenant content: `benchmarks/http/load.bench.ts:85-93`.

## Why it blocks 1.0

It is a *multi-tenant* package: the #1 guarantee an adopter needs is "tenant A never sees tenant B's
data". Today there is no evidence of that property on the path and under production concurrency.
"Zero leaks" as measured is almost a tautology.

## Acceptance criteria

- [ ] A benchmark fires concurrent requests alternating `x-tenant-id` across N tenants and
      **correlates request↔response by content** (not just the echoed `tenantId`): every note
      returned must belong to the requested tenant.
- [ ] The assertion runs for all three drivers and `isolationCheck` is a **hard gate** (the process
      exits ≠0 and the CI job fails on `FAIL`).
- [ ] There is a negative "self-test": forcing an incorrect correlation must produce `FAIL` (proof
      that the bench actually detects leaks).
- [ ] The **rowscope-pg limit** is measured and documented: a raw/unscoped query inside a tenant's
      context returns rows from others (a known design boundary), recorded explicitly.
- [ ] An isolation assertion exists on the **write path** too, under churn/concurrency.

## Closing benchmark(s)

B-1 (concurrent HTTP isolation with content-based correlation + self-test) and B-7 (write path
under churn with `writeIsolationCheck`). It requires seeding tenant-identifiable titles
(`seedIdentifiableNotes`, because `/tenant/notes` orders `id desc limit 20` and the old `marker:`
falls outside the window: `benchmarks/fixture/start/routes.ts:17-24`).

## Fix options (with trade-offs)

1. **Content-based assertion over HTTP** (recommended): exercises the real ALS + adapter + pool under
   concurrency. It is the test closest to production.
2. **ALS context stress**: inject `await`/emitters/`setImmediate` into the handler to try to break
   context propagation. Complements (1); harder to make deterministic.
3. **DB-level assertion with concurrent `tenancy.run()`**: cheaper but does not exercise HttpContext.
   Useful as an extra layer, not as a substitute.
