---
title: Troubleshooting & gotchas
description: The non-obvious pitfalls and how to avoid each, covering tenant resolution, the provisioning race, fail-open vs fail-closed, replica staleness, and testing against the compiled build.
---

# Troubleshooting & gotchas

The sharp edges, gathered in one place. Each entry is a real failure mode with
the fix.

## Always resolve the tenant via the helper

Reading the tenant header directly bypasses `resolverStrategy`/`resolverChain`,
so code that "works" under the `header` strategy breaks silently under
`subdomain` or `path`.

```ts
// ❌ strategy-dependent, bypasses validation
const id = request.header('x-tenant-id')

// ✅ honours the configured strategy + UUID validation
import { resolveTenantId } from '@adonisjs-lasagna/saas-tenancy/extensions/request'
const id = resolveTenantId(request)
```

`request.tenant()` (memoised per request) is the higher-level option when you
need the full tenant model.

## The provisioning → active race (transient 503s)

Creating a tenant enqueues an async install job. Between the row being created
(`provisioning`) and the schema being ready (`active`), a request to that tenant
gets `TenantNotReadyException` (503). This is **correct**, so don't treat the
503 as a bug:

- Wait for `TenantActivated` (or poll status) before redirecting the user in.
- In tests, provision synchronously (the demo's `installInline`) or await the
  job before issuing tenant requests.

## fail-open quotas silently stop enforcing

With `resilience.redis.quota: 'fail-open'` (the default), a Redis outage makes
`QuotaService.consume()` return `0` and **skip enforcement**, choosing
availability over correctness. That's intentional, but it's invisible unless you
watch for it:

- Subscribe to the `DependencyDegraded` event and alert on a burst.
- Switch that quota to `'fail-closed'` if abuse protection must hold during an
  outage. Callers then get `DependencyUnavailableException` (503 + Retry-After).

See [Configuration → Resilience](./configuration#resilience-degradation-policy).

## Read replicas can serve stale data

Replica selection is strategy-based only, with **no lag check and no
auto-failover**. A replica that is behind (or down) is still selected. Route
read-after-write and latency-sensitive reads to the primary, or add a health
gate in front. See [Read replicas](./read-replicas).

## Custom domains + the header strategy

If a request can carry both a custom-domain host and a tenant header, a
mismatched header is rejected with `TenantHeaderDomainMismatchException` (400),
which defends against header-spoofed cross-tenant access. Keep your resolver chain
ordered so the trusted source (domain) wins; don't "fix" the 400 by trusting the
header.

## Circuit breaker reopens after a restart

Breaker state is persisted to Redis and **restored on process start**: a tenant
whose DB was down stays OPEN across a deploy, failing fast instead of issuing
5-second-timeout probes. The trade-off: if the DB recovered *during* the
restart, the first probe waits one `circuitBreaker.resetTimeout`. That bounded
delay is deliberate. Use `tenant:doctor --fix` to force-close if needed.

## Replaying old Stripe events works, even past 30 days

`tenant:billing:replay` re-fetches events from Stripe, but events age out of
Stripe's ~30-day window. The webhook controller persists a PII-stripped,
structurally-faithful copy in `stripe_processed_events.payload`, and
`retrieveEvent()` falls back to it, so replay of an aged-out event still assigns
the correct plan. Rows written before this behaviour (legacy flat payloads)
can't be reconstructed, so those surface the original Stripe error.

## Integration tests run against `build/`, not `src/`

The fixture app imports `@adonisjs-lasagna/saas-tenancy/...`, which the `exports`
map resolves to `./build/src/...`. So:

- `npm run test:integration` runs `npm run build` first, so **don't skip it**.
- Editing source and re-running integration tests *without* rebuilding silently
  tests stale code.
- Unit tests (`tests/unit/`) import source paths directly and need no build.

See [Testing](./testing).

## Services that statically import the logger can't be unit-tested

`@adonisjs/core/services/logger` top-level-awaits `app.booted()`, which throws
outside an Ignitor. Services that need to be unit-testable lazy-load it
(`const lazyLogger = () => import('@adonisjs/core/services/logger').then(m => m.default).catch(() => null)`)
rather than importing it statically. Follow that pattern in custom services.
