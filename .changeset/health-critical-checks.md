---
'@adonisjs-lasagna/saas-tenancy': minor
---

Readiness checks can now be registered as critical: `health.addCheck(name, fn, { critical: true })` makes a failure of that single check report `fail` (HTTP 503 from `/readyz`) even while other checks pass. The auto-bootstrapped `backoffice_db` and `redis` checks are critical by default, so a pod that loses Postgres or Redis is pulled from rotation instead of lingering in `degraded` with a 200. Register your own checks under those names to opt out. `HealthService.isCritical(name)` exposes the registration flag, and `TenantMaintenanceException` now renders a `Retry-After` header on its 503 response.
