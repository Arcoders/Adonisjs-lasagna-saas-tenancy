---
title: Resilience
description: A per-dependency degradation policy. Decide, per backing service, whether an outage fails open (stay available) or fails closed (return 503), with a DependencyDegraded event for alerting and a typed DependencyUnavailableException.
---

# Resilience

When a backing dependency (Redis, Postgres, Stripe) is down, what should
happen? For a SaaS with thousands of tenants that is an operational
property, not a decision to scatter across services. Lasagna routes those
failures through one typed, observable contract so ops can configure and
alarm on them in one place.

Before this existed, each subsystem reacted to a Redis outage differently:
quotas silently returned `0` and stopped enforcing, the rate limiter threw a
typed 503, and others surfaced a raw driver error. The resilience policy
unifies that.

## The contract

`ResilienceService.run()` wraps a dependency call. On failure it applies the
configured policy and, either way, records the degradation.

```ts
import { ResilienceService } from '@adonisjs-lasagna/saas-tenancy/services'

const resilience = new ResilienceService()

const value = await resilience.run({
  dependency: 'redis',          // 'redis' | 'postgres' | 'stripe' | …
  operation: 'quota.consume',   // a label for telemetry
  policy: 'fail-open',          // 'fail-open' | 'fail-closed'
  tenantId,                     // optional, attached to the event/span
  fallback: () => 0,            // returned on a fail-open failure
  run: async () => redis.eval(/* … */),
})
```

Keep only the dependency call inside `run`. Business or domain throws (a
`QuotaExceededException`, for example) belong outside it, so they are never
mistaken for an infrastructure failure.

## Policies

| Policy | On failure | Use when |
|---|---|---|
| `fail-open` | Returns `fallback()` and continues. Availability over correctness. | Losing the check briefly is acceptable (skip a quota count, miss a metric). |
| `fail-closed` | Throws `DependencyUnavailableException` (503 + `Retry-After`). Correctness over availability. | The check must hold even during an outage (rate limiting, abuse protection). |

Either path logs the degradation, annotates the active OpenTelemetry span, and
emits a `DependencyDegraded` event when `config.resilience.observe` is left on.

## Configuration

Set the policy per backing dependency in `config/multitenancy.ts`. Every field
is optional and falls back to the documented default.

```ts
resilience: {
  redis: { quota: 'fail-open', rateLimit: 'fail-closed' },
  observe: true,
}
```

| Key | Default | Effect |
|---|---|---|
| `redis.quota` | `'fail-open'` | `QuotaService.consume/track`. Fail-open returns `0` (no enforcement). |
| `redis.rateLimit` | `'fail-closed'` | `RateLimitMiddleware` for routes that pass no `failOpen` option (an explicit per-route value still wins). |
| `observe` | `true` | Emit `DependencyDegraded` + log + OTel span event on each degradation. |
| `defaultPolicy`, `redis.cache`, `redis.metrics` | reserved | Typed but **not consulted yet** — the cache bootstrapper and `MetricsService` currently always fail open, and no generic default-policy fan-out exists. Setting them today has no effect. |

Full reference: [Configuration → Resilience](./configuration#resilience-degradation-policy).

::: warning Fail-open is silent enforcement loss
A `fail-open` quota means a Redis outage stops enforcing limits. That is the
right default for availability, but it is invisible unless you subscribe to
`DependencyDegraded`. Choose `fail-closed` where correctness beats uptime.
:::

## The tenant circuit breaker

The per-tenant circuit breaker is a separate mechanism from the dependency
policies above, and it answers a common production worry directly: **a Redis
outage cannot take it down.**

The decision is in-memory and per-tenant. Each tenant gets its own in-process
opossum breaker that trips on real `SELECT 1` probes against *that tenant's*
database connection. When a tenant's DB starts failing, its breaker opens and the
tenant fails fast (no more 5-second-timeout probes) while every healthy tenant is
untouched. Redis is **not** in this decision path.

Redis is used for one thing only: a best-effort cache of the OPEN state across
process restarts, so a tenant whose DB was down stays OPEN through a deploy
instead of re-learning it from scratch. Every read and write of that cache is
wrapped in a try/catch that logs a warning and carries on. So when Redis is
unavailable:

- The breaker keeps working entirely from memory. It does not fail open, and it
  does not fail closed.
- Persisting a state change (open, close, half-open) logs a warning and moves on.
- Restoring on startup logs a warning and the breaker simply starts CLOSED, then
  re-learns the tenant's health from its next probe.

The only degraded case is narrow: if the process restarts *during* a Redis
outage, the persisted OPEN state is lost, so the first request to that tenant
pays one bounded `circuitBreaker.resetTimeout` before the breaker re-trips. That
is the same bounded delay described in
[circuit breaker reopens after a restart](/docs/gotchas#circuit-breaker-reopens-after-a-restart),
and it is deliberate.

The path is covered end to end: a unit test asserts the full open/reset/destroy
cycle never throws with no Redis bound, and an integration test forces the wired
Redis to reject every command and proves the breaker still opens, resets, and
restores without throwing.

## The exception

A `fail-closed` dependency throws `DependencyUnavailableException` instead of a
raw driver error: a clean `503` with a `Retry-After` header, carrying
`dependency`, `operation`, and `tenantId`.

```ts
import { DependencyUnavailableException } from '@adonisjs-lasagna/saas-tenancy/exceptions'

try {
  await quotas.consume(tenant, 'apiRequests', 1)
} catch (err) {
  if (err instanceof DependencyUnavailableException) {
    // Surface the Retry-After so clients back off instead of busy-looping.
    return response.status(503).header('Retry-After', '5').send({ retry: true })
  }
  throw err
}
```

See the [Exception reference](./exceptions) for the full table.

## The event

`DependencyDegraded` fires whenever a wrapped call fails and the policy kicks
in. Subscribe to it to drive paging: a burst means a backing service is down.

```ts
import emitter from '@adonisjs/core/services/emitter'
import { DependencyDegraded } from '@adonisjs-lasagna/saas-tenancy/events'

emitter.on(DependencyDegraded, ({ payload }) => {
  // payload: { dependency, operation, tenantId, policy, errorCode }
  pager.warn(`dependency ${payload.dependency} degraded on ${payload.operation}`)
})
```

The payload is alert-safe: a dependency name, an operation label, an optional
tenant id, the policy that was applied, and a best-effort error code. No driver
message, no PII.

## Where it is adopted

- `QuotaService.consume` and `track` route Redis through the policy. The old
  silent `return 0` on an outage is gone; it now follows `redis.quota` and
  emits `DependencyDegraded`.
- `RateLimitMiddleware` emits the same `DependencyDegraded` event so ops alarm
  on one signal for any Redis-backed subsystem, while keeping its per-route
  `failOpen` knob.

The service is a stateless container singleton, so `new ResilienceService()`
works anywhere you want to wrap your own dependency call with the same policy.

## Read next

- [Configuration → Resilience](./configuration#resilience-degradation-policy)
- [Exception reference](./exceptions)
- [Troubleshooting → fail-open quotas](./gotchas#fail-open-quotas-silently-stop-enforcing)
- [Quotas](./satellites/quotas)
