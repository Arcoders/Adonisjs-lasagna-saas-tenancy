# `@adonisjs-lasagna/saas-tenancy` benchmarks

Private workspace. Not published. It exists to (1) produce the empirical **1.0.0
performance baseline** that backs the numbers in
[scaling-limits.md](../docs/docs/scaling-limits.md) and the generated
[performance.md](../docs/docs/performance.md), and (2) provide a repeatable,
CI-runnable **regression gate** over the hot paths.

## What it measures (tiers)

| Tier | Where | What | Needs |
|---|---|---|---|
| 1 Micro | pure imports from built core, no app | resolver chain, adapter routing, the connection LRU, the row-scope predicate | nothing (CPU only) |
| 2 DB | a booted headless app (the fixture) | per-driver query latency, cold-connection cost, connection churn (mixed read+write) + read/write leakage checks | Postgres |
| 3 HTTP | the served fixture | end-to-end req/s per driver, middleware overhead, resolver-strategy cost | Postgres + Redis |
| 4 Memory | a booted headless app (the fixture) | connection budget (steady **and** honest burst under the 30s grace) + saturation/recovery, catalog-bloat curve via `search_path` | Postgres |
| Isolation | the served fixture | **content-correlated** cross-tenant assertion under concurrency, on the real request path (ALS) — `isolationCheck` is a hard gate | Postgres + Redis |
| Soak | a booted headless app | long-running churn; RSS/heap/backend/fd time series + `soakStableCheck` | Postgres |
| Resilience | the served fixture + Docker | Redis/Postgres `docker stop/start`; asserts the real fail policy (rate-limit 503 fail-closed) + recovery | Postgres + Redis + Docker |

All three production isolation drivers are exercised: `schema-pg`, `database-pg`,
`rowscope-pg`. The driver is selected per run by the `BENCH_DRIVER` env var, which the
fixture maps straight onto `config.isolation.driver`.

> **Correctness vs throughput.** Tiers that assert isolation/recovery emit a
> `*Check: PASS|FAIL` field and exit non-zero on `FAIL`; `bench:check` also fails the
> build on any `*Check=FAIL` regardless of the throughput tolerance. The
> connection-budget *burst* tier reports the honest open-connection count under the
> production 30s grace (open ≈ N, not the cap) — the steady tier shrinks the grace to
> 50ms only to show the cap binding in isolation.

## The fixture (`fixture/`)

A deliberately lean AdonisJS 7 app: only the providers the tenancy stack needs (app,
hash, lucid, redis, queue, the multitenancy provider, and a local provider that binds
`TENANT_REPOSITORY`). No billing / sso / admin / backup. That is the whole reason it is a
separate app and not the core test fixture, which loads all the satellites and would add
overhead and noise to the HTTP numbers.

Tiers 2 and 4 boot this app **headless** (an `Ignitor` with no HTTP listener, the same
bootstrap shape as the core integration runner) and call the drivers + the live `db`
service directly. Tier 3 serves it over HTTP. The drivers lazy-import
`@adonisjs/lucid/services/db` (which awaits `app.booted(...)`) and read `getConfig()`, so a
booted app is mandatory for anything that touches the DB.

## Running locally

```bash
# From the repo root. The fixture imports the built core via the workspace symlink,
# so a fresh build is mandatory before any DB/HTTP/mem tier.
npm run build

# Tier 1 needs no services:
npm run bench:micro

# Tiers 2-4 need the dedicated bench services (ports 5544 / 6390, DB lasagna_bench):
docker compose -f benchmarks/docker-compose.yml up -d

# Seed, then run a DB / HTTP / memory tier for a given driver:
BENCH_DRIVER=schema-pg npm run bench:seed
BENCH_DRIVER=schema-pg npm run bench:db
BENCH_DRIVER=schema-pg npm run bench:http
BENCH_DRIVER=schema-pg npm run bench:mem

# Correctness + resilience + soak (self-seeding):
BENCH_DRIVER=schema-pg npm run bench:isolation          # cross-tenant assertion under load
BENCH_ISO_SELFTEST=1 npm run bench:isolation            # negative control: must FAIL
BENCH_DRIVER=schema-pg BENCH_SOAK_HOURS=0.1 npm run bench:soak
BENCH_RESILIENCE=1 BENCH_REDIS_CONTAINER=benchmarks-redis-1 \
  BENCH_PG_CONTAINER=benchmarks-postgres-1 npm run bench:resilience

# Repeat with BENCH_DRIVER=database-pg and BENCH_DRIVER=rowscope-pg.

# Aggregate results/*.json into docs + injected scaling-limits numbers:
npm run bench:report

# Compare the latest results against a committed baseline (gate):
npm run bench:check
```

On Windows/PowerShell set the env var inline with `$env:BENCH_DRIVER='schema-pg'` before
the command, or use the cross-platform default (`schema-pg`).

## Reading results

Every result JSON in `results/` (gitignored) carries an `env` block (cpu, mem, node, pg,
commit sha, timestamp) so a number is never separated from the machine that produced it.
Micro numbers are ns/op + ops/sec with median / p99 / stddev. DB and HTTP numbers are
latency percentiles + throughput.

## The committed baselines (`baselines/`, tracked)

- **`1.0.0.json`** — the intended home for the absolute numbers quoted in the docs.
  **It is currently a scaffold (no metrics).** The turnkey way to capture it is the
  **Capture 1.0.0 baseline** workflow (`.github/workflows/capture-baseline.yml`): it runs
  the full-size sweep on a Linux runner, aggregates the throughput tiers
  (`bench:report -- --runs=5 --write-baseline=1.0.0`), and opens a PR with the baseline,
  the raw snapshot, and the regenerated docs (the provisional caveat drops on Linux). Two
  ways to start it:
  - **From the default branch:** Actions → *Capture 1.0.0 baseline* → *Run workflow* (the
    `workflow_dispatch` button only appears once the file is on the default branch).
  - **From a feature branch, without merging:** push a tag matching `capture-baseline*` —
    `git tag capture-baseline-3 && git push origin capture-baseline-3` (the trailing
    number is the run count to aggregate; omit it for 5). The tag push runs the workflow
    at that commit and opens the PR back into the branch holding the tag.

  To capture on a dedicated VM by hand instead, run the sweep there and use the same
  `bench:report` command. Until a capture lands, the generated docs page prints its
  provisional caveat and `bench:check --baseline=1.0.0` compares nothing. Do not quote a
  docs headline that has no committed source here.
- **`ci-ubuntu.json`** — captured on the GitHub `ubuntu-latest` runner and used by the
  regression gate, so the gate compares like-for-like and tolerates runner noise. It is
  a CI-sized run and **not** the same as a `full_size` representative capture.
- **`raw/`** — committed raw JSONs behind a representative capture, so the report's
  numbers are reproducible from the repo (see `baselines/raw/README.md`).

### Canonical reference machine for `1.0.0.json`

Record the exact spec here whenever the baseline is (re)captured, so the numbers are
reproducible:

```
provider/instance : <e.g. AWS c7i.xlarge>
vCPU / RAM        : <e.g. 4 vCPU / 8 GiB>
OS / kernel       : <e.g. Ubuntu 24.04, 6.8.x>
Postgres          : 16.x (local, fsync=off bench config)
Node              : 24.x
captured-at       : <date>  commit: <sha>
```

Do **not** capture `1.0.0.json` on Windows + Docker Desktop; the VM layer there understates
throughput and the number would mislead.

## Methodology

Warmup then a fixed sample count; report median + p99 + stddev; discard the first run; GC
between groups (`--expose-gc`, already wired into `bench:micro`); one concurrency knob per
run; seeded data with fixed tenant UUIDs and fixed row sizes. See
[../docs/docs/performance.md](../docs/docs/performance.md) for the published write-up.
