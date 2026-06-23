---
"@adonisjs-lasagna/saas-tenancy": minor
---

Add plan-aware per-tenant rate limiting. Plans can now declare an optional
`rateLimit: { limit, windowSeconds }` block in `config.plans.definitions`, and a
new `enforceRateLimit()` middleware reads the resolved tenant's plan to apply a
tier-specific ceiling — a `free` tenant can be throttled tighter than a `pro`
tenant without hardcoding limits per route. It reuses the existing Redis
sliding-window limiter and exceptions; a plan that omits `rateLimit` is not
routable through `enforceRateLimit()`. Documented at `/docs/rate-limiting`.
