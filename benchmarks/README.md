# `@adonisjs-lasagna/saas-tenancy` benchmarks

Private workspace. Not published. It exists to (1) produce the empirical **1.0.0
performance baseline** that backs the numbers in
[scaling-limits.md](../docs/docs/scaling-limits.md) and the generated
[performance.md](../docs/docs/performance.md), and (2) provide a repeatable,
CI-runnable **regression gate** over the hot paths.

## What it measures (4 tiers)

| Tier | Where | What | Needs |
|---|---|---|---|
| 1 Micro | pure imports from built core, no app | resolver chain, adapter routing, the connection LRU, the row-scope predicate | nothing (CPU only) |
| 2 DB | a booted headless app (the fixture) | per-driver query latency, cold-connection cost, connection churn + leakage check | Postgres |
| 3 HTTP | the served fixture | end-to-end req/s per driver, middleware overhead, resolver-strategy cost | Postgres + Redis |
| 4 Memory | a booted headless app (the fixture) | connection budget vs N tenants, catalog bloat curve | Postgres |

All three production isolation drivers are exercised: `schema-pg`, `database-pg`,
`rowscope-pg`. The driver is selected per run by the `BENCH_DRIVER` env var, which the
fixture maps straight onto `config.isolation.driver`.

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

## The two committed baselines (`baselines/`, tracked)

- **`1.0.0.json`** — the absolute numbers used in the docs. Captured **once** on a
  dedicated Linux cloud VM with a documented spec (see below), because Windows + Docker
  Desktop and shared CI runners both understate real DB/HTTP throughput.
- **`ci-ubuntu.json`** — captured on the GitHub `ubuntu-latest` runner and used by the
  regression gate, so the gate compares like-for-like and tolerates runner noise.

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
