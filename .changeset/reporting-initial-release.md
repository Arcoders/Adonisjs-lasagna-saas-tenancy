---
"@adonisjs-lasagna/reporting": minor
---

Initial experimental release of `@adonisjs-lasagna/reporting`: cross-tenant
analytics over the backoffice `tenant_metrics` table. Adds `ReportingService`
(period aggregates with error rates, top-N tenant rankings, and a busiest-first
tenant iterator), an `assertNotInTenantScope()` data-leak guardrail, a
`tenant:report:generate` command, and a mountable `multitenancyReportingRoutes()`
dashboard endpoint. The dashboard is fail-closed: it requires an auth `middleware`
(or an explicit `middleware: false` to mount public) and validates `period`/date
query input. Aggregating in the shared backoffice schema is isolation-safe by
construction. Requires PostgreSQL 13+.
