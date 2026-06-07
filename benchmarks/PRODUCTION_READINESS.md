# Production readiness — `@adonisjs-lasagna/saas-tenancy`

**Date:** 2026-06-07 · **Branch:** `LASAGNA-020626/isolation-hardening-and-benchmarks`
(updates the 2026-06-06 carril-a report)

This report summarizes what is measured, tested, and green, and gives an honest verdict on
production readiness. It is the committed companion to the deeper, run-specific notes in
[results/PERFORMANCE_ASSESSMENT.md](results/PERFORMANCE_ASSESSMENT.md) (gitignored, local).

## How to read this

There are two kinds of evidence here, and they earn trust differently:

- **Correctness (PASS/FAIL).** Host-independent. Validated this session against real Postgres
  and Redis (Docker). A leak, a broken fail policy, or an unstable soak shows up the same on any
  machine. These are the claims you can lean on.
- **Absolute performance (µs, req/s).** Host-dependent. The numbers quoted below come from the
  committed canonical 1.0.0 baseline ([baselines/1.0.0.json](baselines/1.0.0.json)), captured on a
  pinned Linux runner and aggregated over 2 full sweeps. The separate CI baseline
  ([baselines/ci-ubuntu.json](baselines/ci-ubuntu.json)) stays the like-for-like input to the
  regression gate; it runs on a different, faster host, so its absolutes read higher and are not the
  quotable figure.

## Validation environment

- **Correctness smoke (this session):** Windows + Docker Desktop, PostgreSQL 16
  (`max_connections=300`, `fsync=off`), Redis 7, Node 24.
- **Canonical absolutes:** Linux runner, AMD EPYC 7763 (4 vCPU, 16.8 GB), PostgreSQL 16.14,
  Node 24.16, commit `dc4e35f`, median of 2 full sweeps
  ([baselines/1.0.0.json](baselines/1.0.0.json)).
- **Regression-gate baseline:** GitHub `ubuntu-latest`, Intel Xeon 8370C (4 vCPU), commit
  `a668a65`, CI sizes ([baselines/ci-ubuntu.json](baselines/ci-ubuntu.json)).

## What is solid and tested

| Area | What it asserts | Result | Status |
|---|---|---|---|
| Tenancy CPU overhead | per-request cost of the tenancy layer | header resolve ~38 ns, adapter route ~266 ns, LRU touch ~135 ns | ✅ |
| Tenant isolation (HTTP, concurrent) | each response carries only its tenant's data, on the real request path (resolver → adapter → AsyncLocalStorage) | 0 cross-tenant / 2000 requests, `isolationCheck: PASS`; negative self-test fails as designed | ✅ |
| Write isolation under churn | writes route to the correct tenant under concurrency | `writeOps > 0`, `writeIsolationCheck: PASS` | ✅ |
| Connection budget (default 30 s grace) | open connections vs tenant count | `openDuringBurst ≈ N`, `cap-exceeded` — the honest, measured behavior (see verdict) | ✅ measured |
| Hard connection cap (`enforceConnectionCap`) | the cap becomes a real bound when enabled | open held at the cap (50), excess refused with 503 (`opened: 50, rejected: 100`), `hardCapCheck: PASS` | ✅ |
| Saturation + recovery | clean failure at the ceiling, recovery after drain | `failClosedCheck: PASS`, recovered in ~24 ms | ✅ |
| Catalog growth via `search_path` | real planning cost as the catalog grows | `planSearchPath > planQualified` (1151 vs 1031 µs at K=100), flat through K=1000 | ✅ |
| Per-database catalog (database-pg) | the database-pg catalog model | per-database (bounded); cross-database backend count reported honestly | ✅ |
| Soak | stability over time (RSS/heap/backends/fds time series) | flat after warmup, `soakStableCheck: PASS` | ✅ harness |
| Resilience — Redis down | rate-limit fails closed on a backend outage | **503** + recovery ~212 ms, `failPolicyCheck: PASS` | ✅ (after fix) |
| Resilience — Postgres down | tenant route fails closed + recovery | **503** (`DependencyUnavailableException`) + recovery, `failPolicyCheck: PASS` | ✅ (after fix) |
| Core unit tests | regression coverage | **510 / 510 pass** | ✅ |
| Correctness gate | blocks leaks and broken fail policies | any `*Check = FAIL` fails the build; green now | ✅ |

## Fixes shipped this session (core)

- **Rate-limit fail-open closed.** ioredis `pipeline.exec()` resolves with per-command
  `[error, value]` tuples instead of rejecting on a Redis outage, so the middleware read
  `count = 0` and let the request through. It now treats a null result set, any per-command
  error, or a non-numeric `zcard` as a backend failure and applies the policy (default 503).
  Found by the new resilience tier; covered by a regression test.
- **Optional hard connection cap.** New `isolation.enforceConnectionCap` (default `false`).
  When enabled, `connect()` refuses a new tenant connection with `TenantConnectionLimitException`
  (503) instead of exceeding `maxTenantConnections` while everything is in the grace window. The
  default preserves the safe "never sever an in-flight request" behavior.

## Absolute performance — canonical 1.0.0 baseline (Linux, median of 2 runs)

| Driver | SELECT by id | INSERT | 2-table JOIN | cold connection | HTTP guarded read |
|---|--:|--:|--:|--:|--:|
| schema-pg | 406 µs | 333 µs | 738 µs | 7.2 ms | 612 req/s |
| database-pg | 399 µs | 346 µs | 724 µs | 7.3 ms | 619 req/s |
| rowscope-pg | 469 µs | 412 µs | 1.07 ms | n/a (shared) | 797 req/s |

Tenant-free ceiling ~17–18k req/s on this 4 vCPU EPYC instance. A larger instance with right-sized
pools scales the absolutes up; the durable signal is the relative shape (rowscope cheapest under
HTTP concurrency, schema ≈ database for point reads, the guard within noise, the rate limiter a
fixed Redis hop). The CI baseline on a faster Xeon runner reads higher in absolute terms, which is
why the pinned EPYC capture is the figure we quote.

## Verdict: ready, shipping as release-candidate

**Solid and ready to lean on:** cross-tenant isolation under concurrency on the real request
path, a rate limiter that fails closed when Redis is down, recovery after Redis and Postgres
outages, negligible tenancy CPU overhead, and a regression gate that blocks correctness failures.

**All four readiness conditions from the 2026-06-06 report are now cleared:**

1. **Connection budget under the default grace — decided.** The safe default stands:
   `enforceConnectionCap` stays `false` (the LRU exceeds the cap rather than sever an in-flight
   request). The hard-cap path is the documented opt-in for a firm 503 bound; mitigations (opt-in
   cap, size `max_connections` to `maxTenantConnections × poolMax` + headroom, front Postgres with
   **PgBouncer**) are written up in [docs Scaling limits](../docs/docs/scaling-limits.md).
2. **Canonical 1.0.0 absolute — captured.** [baselines/1.0.0.json](baselines/1.0.0.json) holds a
   pinned Linux capture (AMD EPYC 7763, PostgreSQL 16.14, Node 24.16, median of 2 full sweeps,
   commit `dc4e35f`), so the generated performance docs no longer print their provisional caveat.
   The **Capture 1.0.0 baseline** workflow
   ([.github/workflows/capture-baseline.yml](../.github/workflows/capture-baseline.yml)) reproduces
   it: it runs the full sweep on a Linux runner, aggregates several runs
   (`npm run bench:report -- --runs=5 --write-baseline=1.0.0`), and commits the raw snapshot under
   [baselines/raw/](baselines/raw/README.md). Start it from the default branch (*Run workflow*), or
   from a feature branch without merging by pushing a tag matching `capture-baseline*` (e.g.
   `capture-baseline-3`).
3. **Resilience + soak on Linux CI — wired.** `resilience` now runs on the weekly schedule (was
   dispatch-only) alongside `soak`; see [.github/workflows/benchmark.yml](../.github/workflows/benchmark.yml).
   Remaining: confirm the first scheduled run stays green.
4. **Postgres-outage policy — fixed; cap default — decided.** A Postgres outage on the tenant path
   now returns a clean **503** (`DependencyUnavailableException`) instead of a raw 500:
   `request.tenant()` maps both an unreachable tenant registry and an unreachable tenant connection
   to a 503, locked by `tests/integration/middleware/connection_failure_503.spec.ts` and asserted by
   the resilience tier (`expectedStatus: 503`). `enforceConnectionCap` stays `false` by default.

**What graduation from release-candidate to `stable` still needs.** These are the two things a
benchmark suite cannot supply on its own, and they are why the core ships as a release-candidate
rather than `stable` (see [docs/docs/stability.md](../docs/docs/stability.md)):

- An **independent external security review** of the isolation core. The audit run this session is
  a deep internal self-review, not third-party validation.
- **Real production mileage**: weeks of real tenant traffic with no isolation incident.

Until both land, the core stays `release-candidate` and the satellites stay `experimental`; the
core then moves to `stable` inside the 1.x line with no major bump.

## Guidance by scale

- **10–100 tenants:** defaults are fine. Keep `maxTenantConnections` above your concurrent-tenant
  peak so hot tenants stay warm.
- **100–1.000 tenants:** watch the connection budget. Either cap concurrency with
  `enforceConnectionCap` or front Postgres with PgBouncer. RSS grows with tenant registration
  bookkeeping, not with open pools.
- **1.000–10.000 tenants:** PgBouncer (transaction pooling) is effectively required;
  `max_connections` cannot scale linearly with tenants. Consider `database-pg` for fewer,
  higher-value tenants and sharding past the few-thousand mark.

## Recommended production config (starting point)

- `maxTenantConnections` ≈ peak concurrent distinct tenants, kept under
  `PG max_connections / poolMax`.
- `evictionGracePeriodMs` ≥ your p99 request latency (never sever an in-flight request).
- `enforceConnectionCap: true` when fronted by PgBouncer or when a hard server-connection bound
  matters more than serving every burst.
- Driver by scale: **schema-pg** (default) for tens to thousands of tenants; **database-pg** for
  fewer, higher-value tenants needing stronger isolation; **rowscope-pg** for very many small
  tenants (cheapest reads, weakest OS-level isolation).

## Reproduce / verify

```bash
npm run build
docker compose -f benchmarks/docker-compose.yml up -d
BENCH_DRIVER=schema-pg npm run bench:isolation        # isolationCheck: PASS
BENCH_ISO_SELFTEST=1   npm run bench:isolation        # must FAIL (proves detection)
BENCH_DRIVER=schema-pg npm run bench:mem              # honest budget + hard-cap scenario
BENCH_DRIVER=database-pg npm run bench:mem            # per-database catalog + cross-DB backends
BENCH_RESILIENCE=1 BENCH_DRIVER=schema-pg npm run bench:resilience
BENCH_SOAK_HOURS=0.1 BENCH_DRIVER=schema-pg npm run bench:soak
npm run bench:check                                    # correctness gate (fails on any *Check=FAIL)
```

The benchmark-side drafts behind these conditions are resolved (01 connection cap, 03 reproducible
evidence, 04 failure/soak, 05 database-pg parity); see [.github/issue-drafts/](../.github/issue-drafts/)
for the history.
