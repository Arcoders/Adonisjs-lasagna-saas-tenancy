---
"@adonisjs-lasagna/saas-tenancy": patch
---

Defense-in-depth: validate the tenant id with `assertSafeIdentifier` in the
cache bootstrapper's `enter()` and in `tenantCache()`, matching the drive / mail
/ session / transmit helpers (the cache path was the only one that did not).
Internal hardening with no public API change. Also clarifies the docs that the
connection LRU evicts the oldest-idle connection (not the noisiest) and that the
circuit breaker is dependency-centric, not a noisy-neighbor guard.
