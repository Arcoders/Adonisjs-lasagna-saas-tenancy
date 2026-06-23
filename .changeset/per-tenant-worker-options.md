---
"@adonisjs-lasagna/saas-tenancy": minor
---

Add a `buildTenantWorkerOptions(tenantId, concurrency?)` helper on a new
`./helpers` subpath. It assembles the per-tenant BullMQ `WorkerOptions` (Redis
connection, name, concurrency) a host needs to run a dedicated worker per tenant
with its own concurrency ceiling, so one noisy tenant's job burst cannot starve
the others. The package stays dispatch-only — the host owns the `Worker`
lifecycle. Documented as a cookbook recipe; weighted fair-share scheduling is a
deferred future satellite.
