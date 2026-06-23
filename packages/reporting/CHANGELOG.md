# Changelog

All notable changes to `@adonisjs-lasagna/reporting` are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

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
