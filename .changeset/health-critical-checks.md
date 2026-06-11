---
'@adonisjs-lasagna/saas-tenancy': minor
---

Readiness checks can now be registered as critical: `health.addCheck(name, fn, { critical: true })` makes a failure of that single check report `fail` (HTTP 503 from `/readyz`) even while other checks pass. The default `backoffice_db` and `redis` checks are critical, so a pod that loses Postgres or Redis is pulled from rotation instead of lingering in `degraded` with a 200.

The default checks are now registered by the provider during `boot()` instead of lazily on the first probe. Your providers boot after the package's, so `addCheck` under a default's name replaces it and `removeCheck` opts it out permanently — nothing re-registers at probe time. The registration itself is exported as `registerDefaultChecks(healthService)` from the `/health` subpath. `HealthService.isCritical(name)` exposes the registration flag, and `TenantMaintenanceException` now renders a `Retry-After` header on its 503 response.

Also exported: `buildCacheStack(options)` from `/services` — the factory the package's cache singleton is built through (memory L1 + Redis L2 + bus), for tests and hosts that need an isolated instance with the exact production wiring.
