---
title: Rate limiting
description: Throttle requests per tenant, with a fixed per-route limit or a plan-aware limit driven by each tenant's plan tier, backed by a Redis sliding window that fails closed by default.
---

# Rate limiting

The package ships a per-tenant request limiter backed by a Redis sliding window.
Every bucket is keyed by `<prefix>:<tenantId>:<ip>`, so one tenant exhausting its
budget never touches another's. There are two ways to apply it.

## Fixed per-route limits

`RateLimitMiddleware` takes a `limit` and `windowSeconds` per route. Use it when
the ceiling is the same for every tenant on that route.

```ts
// start/routes.ts
import { middleware } from '#start/kernel'

router
  .get('/api/search', () => searchHandler())
  .use(middleware.rateLimit({ limit: 30, windowSeconds: 60 }))
```

Responses carry the standard `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and
`X-RateLimit-Reset` headers; an overflow returns `429` with `Retry-After` and the
typed `E_TOO_MANY_REQUESTS` code.

## Plan-aware limits

To give a `free` tenant a tighter ceiling than a `pro` tenant, declare the limit
on the plan and use `enforceRateLimit()`. The middleware resolves the tenant's
plan via `QuotaService.getPlanFor()` and reads the `rateLimit` block, so the
ceiling follows the tenant's tier, not the route.

```ts
// config/multitenancy.ts
plans: {
  defaultPlan: 'free',
  definitions: {
    free: { limits: { apiCallsPerDay: 1_000 }, rateLimit: { limit: 10, windowSeconds: 1 } },
    pro:  { limits: { apiCallsPerDay: 100_000 }, rateLimit: { limit: 100, windowSeconds: 1 } },
  },
}
```

```ts
// start/routes.ts
import { enforceRateLimit } from '@adonisjs-lasagna/saas-tenancy/middleware'

router
  .get('/api/search', () => searchHandler())
  .use(middleware.tenantGuard())   // resolves the tenant the limit is read from
  .use(enforceRateLimit())
```

The `tenantGuard` (or any middleware that resolves `request.tenant()`) must run
first. A plan that omits `rateLimit` is not routable through `enforceRateLimit()`
— the request throws, which is the signal to either add a `rateLimit` to that
plan or drop the middleware from the route for an unlimited tier.

Per-route overrides are still available without losing the per-tenant ceiling:

```ts
// Same plan-derived limit, but over a 5-minute window on this route.
.use(enforceRateLimit({ windowSeconds: 300 }))
```

## Failure policy

A Redis outage is handled by the same `config.resilience.redis.rateLimit` policy
as the rest of the stack, defaulting to **fail-closed** (`503`
`E_RATE_LIMIT_UNAVAILABLE`) so an outage cannot silently disable throttling. Set
`failOpen: true` per route, or flip the global policy, where availability matters
more than abuse protection on that path. See [Resilience](/guides/resilience).

::: warning Trust your proxy config
The bucket key includes `request.ip()`, which honours `X-Forwarded-For` only per
your app's `trustProxy` setting. A misconfigured `trustProxy` lets a client mint a
fresh bucket per spoofed header. Verify it wherever the limiter runs behind a
proxy.
:::

## Related

- [Quotas](/guides/satellites/quotas) — rolling-day usage counters (a separate
  system from request-rate limiting).
- [Resilience](/guides/resilience) — fail-open vs fail-closed policy.
