---
"@adonisjs-lasagna/saas-tenancy": patch
---

Fix the sliding-window rate limiter undercounting requests that arrive in the
same millisecond. The ZSET member was the millisecond timestamp (`${now}`), so
two requests in the same millisecond collided into one member and `ZCARD`
undercounted, letting a burst slip past the configured limit (429 -> 200 under
load). The member now carries a unique per-request suffix, so every request is
counted.

Also adds a protected `getRedis()` seam to `CircuitBreakerService` (mirroring
`RateLimitMiddleware`) so tests can simulate a Redis outage without mutating the
shared `@adonisjs/redis` singleton. No public API change.
