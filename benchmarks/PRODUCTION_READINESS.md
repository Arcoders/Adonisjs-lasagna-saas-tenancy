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
  committed CI Linux baseline ([baselines/ci-ubuntu.json](baselines/ci-ubuntu.json)). They are
  CI-sized and like-for-like for the regression gate, not a polished headline. A fixed, quotable
  1.0.0 absolute still needs a capture on the dedicated Linux reference VM (see the open items).

## Validation environment

- **Correctness smoke (this session):** Windows + Docker Desktop, PostgreSQL 16
  (`max_connections=300`, `fsync=off`), Redis 7, Node 24.
- **Indicative absolutes:** GitHub `ubuntu-latest`, Intel Xeon 8370C (4 vCPU), commit `a668a65`,
  CI sizes.

## What is solid and tested

| Area | What it asserts | Result | Status |
|---|---|---|---|
| Tenancy CPU overhead | per-request cost of the tenancy layer | header resolve ~32 ns, adapter route ~241 ns, LRU touch ~180 ns | ✅ |
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
| Core unit tests | regression coverage | **504 / 504 pass** | ✅ |
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

## Indicative absolute performance (CI Linux, like-for-like, ± runner noise)

| Driver | SELECT by id | INSERT | 2-table JOIN | cold connection | HTTP guarded read |
|---|--:|--:|--:|--:|--:|
| schema-pg | 390 µs | 331 µs | 485 µs | 6.4 ms | 664 req/s |
| database-pg | 371 µs | 320 µs | 537 µs | 6.5 ms | 640 req/s |
| rowscope-pg | 481 µs | 388 µs | 692 µs | n/a (shared) | 935 req/s |

Tenant-free ceiling ~28–29k req/s on 4 vCPU. A larger instance with right-sized pools scales the
absolutes up; the durable signal is the relative shape (rowscope cheapest under concurrency,
schema ≈ database, guard within noise, rate-limit a fixed Redis hop).

## Verdict: conditionally ready

**Solid and ready to lean on:** cross-tenant isolation under concurrency on the real request
path, a rate limiter that fails closed when Redis is down, recovery after Redis and Postgres
outages, negligible tenancy CPU overhead, and a regression gate that blocks correctness failures.

**Cleared since the 2026-06-06 report:**

1. **Connection budget under the default grace — decided.** The safe default stands:
   `enforceConnectionCap` stays `false` (the LRU exceeds the cap rather than sever an in-flight
   request). The hard-cap path is the documented opt-in for a firm 503 bound; mitigations (opt-in
   cap, size `max_connections` to `maxTenantConnections × poolMax` + headroom, front Postgres with
   **PgBouncer**) are written up in [docs Scaling limits](../docs/docs/scaling-limits.md).
3. **Resilience + soak on Linux CI — wired.** `resilience` now runs on the weekly schedule (was
   dispatch-only) alongside `soak`; see [.github/workflows/benchmark.yml](../.github/workflows/benchmark.yml).
   Remaining: confirm the first scheduled run stays green.
4. **Postgres-outage policy — fixed; cap default — decided.** A Postgres outage on the tenant path
   now returns a clean **503** (`DependencyUnavailableException`) instead of a raw 500:
   `request.tenant()` maps both an unreachable tenant registry and an unreachable tenant connection
   to a 503, locked by `tests/integration/middleware/connection_failure_503.spec.ts` and asserted by
   the resilience tier (`expectedStatus: 503`). `enforceConnectionCap` stays `false` by default.

**The one condition remaining before a full production sign-off:**

2. **No quotable 1.0.0 absolute yet.** Capture the full sweep on the dedicated Linux reference VM,
   aggregate several runs (`npm run bench:report -- --runs=5 --write-baseline=1.0.0`), and commit
   the raw snapshot under [baselines/raw/](baselines/raw/README.md).

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

Open issues behind the conditions above: see [.github/issue-drafts/](../.github/issue-drafts/)
(01 connection cap, 03 reproducible evidence, 04 failure/soak, 05 database-pg parity).
