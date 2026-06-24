---
"@adonisjs-lasagna/saas-tenancy": minor
---

Add `mapTenants` — a bounded-concurrency, error-isolated tenant fan-out primitive
(`@adonisjs-lasagna/saas-tenancy/services`).

`mapTenants(tenants, fn, { concurrency, continueOnError })` runs `fn` inside each
tenant's `tenancy.run` scope, bounding peak concurrency (default 10) and collecting
per-tenant failures into `errors` instead of aborting the whole run. It's the safe
building block for report extensions (or any host job) that must read across many
tenant schemas without hand-rolling `tenancy.run`, batching, and per-tenant
try/catch. Built on a new pure `boundedBatch` helper.
