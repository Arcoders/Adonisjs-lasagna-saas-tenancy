# Changelog

All notable changes to `@adonisjs-lasagna/reporting` are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-06-24

**Graduated to release candidate** and grew into an extensible analytics platform.

Added:
- **Custom named metrics.** Host code calls `metrics.emitMetric(tenantId, name, value)`
  (core); values flush to `backoffice.tenant_custom_metrics` alongside the built-ins.
  `ReportingService.getCustomAggregate()` (whitelisted sum/avg/count/max/min) and
  `getCustomMetricsBreakdown()` aggregate them cross-tenant from the backoffice schema —
  no per-tenant fan-out, names validated, the data-leak guard still applies.
- **Report extensions.** A `ReportExtensionRegistry` lets the host register custom
  reports (`ReportExtension`) run via `tenant:report:generate --extension=<name>` or
  `GET {prefix}/reports/extension/:name`.
- **Optional `reporting` config block** (`defineReportingConfig`) for metric metadata,
  validated at boot (`assertReportingConfig`).
- **Dashboard caching** (`cacheTtlMs`, global/backoffice scope), **export formats**
  (`--format=table|json|csv`, `--out`), a **max date-range guard**, and **OpenAPI + Swagger
  UI** (`openapi: true`).
- The dashboard payload now includes `customMetrics`.
- **Data freshness.** `ReportingService.getDataAsOf()` returns the latest flushed
  `period` (or null), surfaced as a `dataAsOf` field on the dashboard payload. Reports
  reflect flushed data only, so this reports how current that data is rather than hiding
  the lag. There is no Redis fallback by design: Redis holds only the partial current
  period and merging it would reintroduce cross-tenant fan-out.
- **Pre-computed monthly rollups** (opt-in via `config.reporting.rollups.enabled`).
  `getAggregate({ period: 'month' })` and `getTopTenants` serve whole-month, fully-closed
  windows from the ~30×-smaller `backoffice.tenant_metrics_monthly` table; every other
  query (day/week, partial/open months, custom metrics) transparently falls back to live
  aggregation, and a closed-window report is byte-identical either way. Adopting it applies
  the `create_tenant_metrics_monthly_table` migration.
- **Cache invalidation on flush** (opt-in via `config.reporting.cache.invalidateOnFlush`).
  The provider subscribes to the core `MetricsFlushed` event and clears the global
  `reporting` cache namespace on each flush, so a cached dashboard (`cacheTtlMs > 0`) goes
  fresh as soon as new data lands. Off by default.

Quality:
- Full integration tier on the shared satellite-test-kit + a chaos suite (cross-tenant
  guard, SQL-injection neutralization, MVCC consistency under concurrent writes,
  soft-deleted hydration, Postgres-outage clean-failure). Wired into CI like its peers
  (unit + integration V8 merged into the per-satellite coverage gate).

Notes:
- Merged-coverage floors (`minMergedCoverage`) are set conservatively (lines 60) for the
  first enforced CI run and will be ratcheted up to the measured baseline.
- Deferred to future iterations: dashboard-panel config, a metrics-management CLI.

Requires the core metrics pipeline; new installs run the
`create_tenant_custom_metrics_table` migration (a core stub).

## [0.1.0] — 2026-06-23

Initial **experimental** release. Cross-tenant analytics over the backoffice
`tenant_metrics` table:

- `ReportingService.getAggregate()` — totals + error rate per day/week/month bucket.
- `ReportingService.getTopTenants()` — top-N tenants by request volume.
- `ReportingService.iterateTenantsByUsage()` — hydrated tenant + usage, busiest first.
- `assertNotInTenantScope()` guardrail — refuses to aggregate inside a tenant scope.
- `tenant:report:generate` ace command and a mountable `multitenancyReportingRoutes()`
  dashboard endpoint.

**Stability: experimental.** The API may change in a minor release until the
satellite graduates to RC. Requires PostgreSQL 13+ (`DATE_TRUNC`) and the core
metrics pipeline (`tenant_metrics` in the backoffice schema).

Known limitations:
- No pre-computed rollup tables (live aggregation only); a future optimization.
- `iterateTenantsByUsage` reads one grouped row per tenant into memory; fine for
  typical fleets, batching is a future improvement.
