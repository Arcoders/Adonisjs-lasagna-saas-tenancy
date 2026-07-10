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
import { resolveTenantId } from '@adonisjs-lasagna/saas-tenancy'
const id = resolveTenantId(request)
```

`request.tenant()` (memoised per request) is the higher-level option when you
need the full tenant model.

## `getConfig()` throws before the provider boots

`getConfig()` reads a module-level singleton that `MultitenancyProvider.boot()`
populates via `setConfig()`. Call it **before** boot — at the top level of a
module that loads during `register()`, or in a unit test that never booted an
Ignitor — and it throws `multitenancy config not set`.

```ts
// ❌ runs at import time, before the provider booted → throws
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
const prefix = getConfig().tenantSchemaPrefix

// ✅ call it inside the function/request, after boot
function schemaFor(id: string) {
  return `${getConfig().tenantSchemaPrefix}${id}`
}
```

This is deliberate: the throw is a guard that surfaces a load-order bug loudly
instead of silently reading `undefined`. In tests, seed it with
`setupTestConfig()` (the `tests/helpers/config.ts` helper) before exercising any
code path that reads config.

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

See [Configuration → Resilience](/reference/configuration#resilience-degradation-policy).

## Read replicas can serve stale data

Replica selection is strategy-based only, with **no lag check and no
auto-failover**. A replica that is behind (or down) is still selected. Route
read-after-write and latency-sensitive reads to the primary, or add a health
gate in front. See [Read replicas](/guides/read-replicas).

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

Use `tenant:billing:dlq:list` to see what's dead-lettered before replaying. For
the full webhook failure/recovery map (queue outage, dead-letters, provider
outage, the Lemon Squeezy replay-window note), see
[Resilience → billing failure modes](/guides/resilience#billing-satellite-failure-modes-and-recovery).

## A resolved tenant whose database is down returns 503, never central

Once a tenant is resolved, an unreachable tenant registry or tenant connection
maps to a typed `DependencyUnavailableException` (HTTP 503) in `request.tenant()`,
the tenant guard, and the universal middleware. The request is never silently
served against the central connection with the wrong context. A permanent
misconfiguration (for example a missing schema template) surfaces as a 500
instead, so a retryable 503 always means "dependency down, try again", not "wrong
config". Only a request that resolves to *no* tenant (a legitimate central route)
still serves central.

## The SSRF guard validates the URL, not the resolved connection IP

`validateExternalHttpsUrl` (used for SSO issuer / discovery URLs and webhook
targets) rejects non-HTTPS URLs and hostnames that resolve into loopback,
private, link-local, or cloud-metadata ranges, including IPv4-mapped IPv6. It
resolves DNS at validation time but does not pin that IP for the actual request,
so a hostname that re-resolves to a private address between the check and the
fetch (DNS rebinding, a TOCTOU window) is a residual risk. Close it at the
network: route app egress through a proxy or security group that denies private
ranges and the metadata endpoint. The [production checklist](/reference/production-checklist)
calls this out.

## A top-level `orWhere` can widen a row-scoped query

Under `rowscope-pg`, the tenant predicate is ANDed onto each query, but a
**top-level** `.orWhere(...)` is ORed against the whole `WHERE` clause, including
that predicate, so it can return rows outside the tenant. Keep alternative
conditions inside a nested group: `query.where((q) => q.where(a).orWhere(b))`.
The SQL-level Row-Level Security backstop (`node ace configure --with=rls`, run
under a non-superuser role) enforces isolation in the database even when app code
slips, which is why it is the recommended hardening for `rowscope-pg`.

## The connection cap trades availability for a firm ceiling

With `enforceConnectionCap: false` (the default), a burst of more than
`maxTenantConnections` concurrently-active tenants makes the pool **exceed** the
cap rather than sever an in-flight request, so open connections trend toward the
number of active tenants. With it `true`, the cap is firm and connection N+1 is
refused with a 503 (`TenantConnectionLimitException`). Size `max_connections`
accordingly and front Postgres with PgBouncer at scale. See
[Scaling limits](/guides/scaling-limits#hard-cap-vs-availability-enforceconnectioncap).

## A full disk or saturated Postgres fails provisioning and writes

The connection cap bounds open connections, not disk, CPU, or IOPS. Provisioning
a tenant runs DDL (`CREATE SCHEMA` plus migrations); on a full disk or an
out-of-resources Postgres it fails and the tenant never reaches `active`, and
tenant writes fail the same way. Monitor disk and Postgres resource saturation
separately from the connection budget, and re-run provisioning
(`tenant:doctor --fix` or re-dispatch the install job) after remediation.

## Integration tests run against `build/`, not `src/`

The fixture app imports `@adonisjs-lasagna/saas-tenancy/...`, which the `exports`
map resolves to `./build/src/...`. So:

- `npm run test:integration` runs `npm run build` first, so **don't skip it**.
- Editing source and re-running integration tests *without* rebuilding silently
  tests stale code.
- Unit tests (`tests/@guarantees/**/unit/`) import source paths directly and need no build.

See [Testing](/guides/testing).

## Services that statically import the logger can't be unit-tested

`@adonisjs/core/services/logger` top-level-awaits `app.booted()`, which throws
outside an Ignitor. Services that need to be unit-testable lazy-load it
(`const lazyLogger = () => import('@adonisjs/core/services/logger').then(m => m.default).catch(() => null)`)
rather than importing it statically. Follow that pattern in custom services.

## Read next

- [FAQ](/reference/faq); shorter answers to common questions.
- [Known limitations](/reference/known-limitations); what is intentionally out of scope.
- [Exceptions](/reference/exceptions); the typed errors and their retry hints.
