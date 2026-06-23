---
"@adonisjs-lasagna/saas-tenancy": minor
---

Add an exported `TenantJob` base class for queue jobs that need a tenant
context. Subclasses implement `perform()`; the base `execute()` resolves the
tenant from `payload.tenantId` and wraps the work in `tenancy.run()`
automatically (so models, cache, drive and logging resolve to the tenant), and
runs globally when the payload carries no `tenantId`. This removes the manual
`logCtx.run()`/`tenancy.run()` wrapping footgun for host and third-party jobs.
Exported from the root and `./jobs`.
