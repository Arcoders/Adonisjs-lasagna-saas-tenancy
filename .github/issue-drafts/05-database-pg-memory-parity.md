# `database-pg` has no memory / budget / catalog coverage

**Labels:** `area/benchmarks`, `area/isolation`, `kind/gap`, `priority/blocker-1.0`

> **✅ RESOLVED (2026-06-07).** Tier 4 runs for all 3 drivers in CI
> (`.github/workflows/benchmark.yml` and `benchmark-correctness.yml`). The catalog is driver-aware
> (`runSchemaCatalog` with the bloat curve via search_path vs `runDatabaseCatalog` per-database;
> rowscope auto-skips) in `benchmarks/src/memory/catalog_bloat.bench.ts`. The `database-pg` backend
> count uses `pgBackendCountAllDatabases` (cross-DB) in `connection_budget.bench.ts`. The report
> distinguishes the conclusions per driver. The file:line references below describe the original
> state, now superseded.

## Summary

Tier 4 (memory + budget + catalog) runs **only** for `schema-pg`. The report's conclusions about
bounded memory and flat catalog are generalized to "the package", but `database-pg` (which creates
**one database per tenant** and is the driver with the highest risk of backend explosion and
per-database catalog overhead) has not a single budget or catalog data point.

On top of that, the server backend cross-check is misleading for database-pg: in the churn it shows
`pgBackends: 1` with `tenantConnectionsOpen: 200`, because database-pg's connections go to *other*
databases and `pgBackendCount` only counts `current_database()`.

## Evidence (file:line)

- Tier 4 schema-pg only in CI: `.github/workflows/benchmark.yml:137-138`.
- Catalog limited to schema-pg in the tier assembly: `benchmarks/src/memory/index.ts:26-28`.
- `pgBackendCount` looks only at `current_database()`: `benchmarks/src/harness/introspect.ts:56-62`.

## Why it blocks 1.0

The report recommends `database-pg` for "higher-value tenants with stronger isolation" without any
data on its connection/memory consumption at scale. It is exactly the driver where the resource
model is most expensive and least understood. Recommending it without measuring it is an unsupported
claim.

## Acceptance criteria

- [ ] Tier 4 (budget + catalog) runs for **all three** drivers in CI.
- [ ] The `database-pg` budget reports connections/backends correctly (counting backends in the
      tenant databases, not just `current_database()`), or explicitly documents the limitation.
- [ ] The `database-pg` catalog is measured according to its real model (per-database catalog: cost
      of creating/enumerating databases and per-database `pg_class` as the databases grow), not with
      schema-pg's global pg_class metric.
- [ ] The report distinguishes the memory/catalog conclusions per driver instead of generalizing them.

## Closing benchmark(s)

B-3 (realistic catalog + multi-driver) and moving Tier 4 to all three drivers (Part C of the plan).

## Fix options (with trade-offs)

1. **Run Tier 4 for all 3 drivers** (recommended): closes the gap directly; lengthens the CI run
   (database-pg provisions many databases, it is slow) → cap N for database-pg.
2. **Cross-DB backend count for database-pg**: query `pg_stat_activity` without filtering by
   `current_database()` (or sum per tenant database). More faithful; somewhat more expensive per snapshot.
3. **Only document the model difference**: cheap but leaves the database-pg recommendation without
   empirical support; insufficient on its own.
