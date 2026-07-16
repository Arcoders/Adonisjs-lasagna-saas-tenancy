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

Full reference: [Configuration → Resilience](/reference/configuration#resilience-degradation-policy).

::: warning Fail-open is silent enforcement loss
A `fail-open` quota means a Redis outage stops enforcing limits. That is the
right default for availability, but it is invisible unless you subscribe to
`DependencyDegraded`. Choose `fail-closed` where correctness beats uptime.
:::

## The tenant circuit breaker

The per-tenant circuit breaker is a separate mechanism from the dependency
policies above, and it answers a common production worry directly: **a Redis
outage cannot take it down.**

It is dependency-centric, not a noisy-neighbor guard. It trips on a tenant's own
database *failing* (the `SELECT 1` probe below), so a broken tenant fails fast
instead of dragging others down. It does **not** watch request volume or shed load
from a tenant that is merely busy. For that, reach for per-tenant
[rate limits](/guides/rate-limiting) and the per-tenant worker concurrency recipe.

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
[circuit breaker reopens after a restart](/reference/gotchas#circuit-breaker-reopens-after-a-restart),
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

See the [Exception reference](/reference/exceptions) for the full table.

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

## Satellite lifecycle: failure modes and recovery

The policies above govern a backing dependency going down. The other axis is the
satellite lifecycle itself: what happens when configure, boot, a tenant destroy, a
migration, or an uninstall hits a failure, and how to recover. Each behaviour below
is covered by a test in the suite.

**Configure fails fast on a bad satellite set.** A missing or circular dependency,
or an ABI-incompatible satellite, aborts the whole `configure` run and publishes
nothing, with diagnostics that name the offender. A half-finished configure is
recovered simply by re-running it; configure is idempotent. The recovery holds even
when publishing got further: if a run copied some stubs and then a later step threw,
re-running completes the install rather than duplicating it, because each step is
idempotent. Stub publishing skips files that already exist
(`filterAlreadyPublished`), and provider and command registration no-op when the
entry is already present.

**A satellite that throws in `boot()` fails the app fast.** Provider boot
validation (a missing optional peer, an unknown driver name, a malformed config)
throws with the satellite named in the message, so the process exits non-zero
instead of coming up half-wired and returning 500 on the first request. There is no
partial start to clean up.

**Tenant destroy is fail-closed.** The `before('destroy')` hook runs before the
schema is dropped, and before-hooks re-throw, so a satellite cleanup hook that
throws aborts the destroy: the schema and its rows stay intact, with no
half-destroyed state to reconcile. A failing `after('destroy')` hook is logged and
the destroy still completes. Destroying one tenant never touches another, because
each cleanup hook is scoped to the destroyed tenant and the schema drop is
per-tenant.

**A satellite migration that fails mid-batch is recoverable.** Each migration runs
in its own transaction, so a failure leaves the migrations that ran before it
committed, the failing one with no table and no row in the migration ledger, and
the error surfaced rather than swallowed. Fix the cause and re-run: only the
failing migration is re-attempted, and the prior ones are skipped.

**Uninstall is a read-only checklist, not an automated drop.**
`tenant:satellite:remove <pkg>` prints the `adonisrc.ts` lines, the published
backoffice migrations, and the config block to remove, but never edits
`adonisrc.ts` or drops a table, because auto-dropping shared backoffice data is a
footgun. Every satellite's tables live in the shared `backoffice` schema (see
[Cross-satellite invariants](/guides/satellites/)), so rolling back its backoffice
migrations is the complete cleanup, with nothing left in any per-tenant schema.
Reinstalling is re-running `configure` / `backoffice:setup`, which is idempotent
and preserves existing rows.

When the backing database itself is unreachable mid-request, a satellite endpoint
fails the same way any tenant route does: a clean 503, never a raw 500 or a
wrong-context serve. See
[a resolved tenant whose database is down returns 503](/reference/gotchas#a-resolved-tenant-whose-database-is-down-returns-503-never-central).

## Billing satellite: failure modes and recovery

The billing satellite turns an unreliable, out-of-order webhook stream into a
consistent local mirror. Each failure mode below has a defined recovery path; the
[billing incident runbook](/guides/satellites/billing#incident-runbook) has the
copy-paste commands, and the
[retries & dead-lettering](/guides/satellites/billing) section documents the queue
contract.

**A webhook can't be enqueued → 503, never a silent drop.** If the queue/Redis is
down when a webhook arrives, the receiver returns 503 so the provider retries on
its own schedule; the idempotency ledger (`INSERT … ON CONFLICT (event_id) DO
NOTHING`) makes those retries safe. Recovery is automatic once the queue is back;
anything the provider gave up on is recovered by `tenant:billing:sync`.

**A webhook fails processing → retry, then dead-letter.** The job classifies the
error: transient errors (network, rate-limit, 5xx) retry with the queue's backoff;
known-fatal errors short-circuit straight to `status='failed'`. Either way an
exhausted event fires `BillingEventDeadLettered`. Inspect with
`tenant:billing:dlq:list`, fix the cause, and re-dispatch with
`tenant:billing:replay`. Wire the event to your pager. See the demo listener in
`examples/api/app/listeners/billing_dead_letter_listener.ts`.

**Provider outage → reconcile.** While the provider is unreachable the mirror
drifts; `tenant:billing:sync` pulls the provider's subscriptions back into the
mirror (forward pass) and downgrades orphaned plans (reverse pass). It is
driver-neutral across Stripe, Paddle and Lemon Squeezy; `tenant:billing:doctor`
warns if the active driver can't enumerate subscriptions.

**Out-of-order delivery → newest wins.** A stale event re-delivered after a newer
one is dropped by the `last_event_at − 5s` ordering guard, so a late
`subscription.updated` can't resurrect a canceled subscription or revert an upgrade.

**A deleted tenant is never resurrected.** A late or replayed event for a tenant
whose lifecycle status is `deleted` is a no-op (the customer mirror can outlive a
soft status flip), so a stray webhook can't re-create a plan or quota for a tenant
that's gone.

**Lemon Squeezy replay window.** Unlike Stripe and Paddle (which enforce a 300s
signature-timestamp tolerance), Lemon Squeezy's webhook HMAC carries no timestamp,
so there is no replay window. The mitigation is the synthetic event id derived from
`sha256(rawBody)`: a leaked secret only lets an attacker replay byte-identical
bodies, which the idempotency ledger already collapses. Distinct payloads (e.g. a
different tenant) hash differently and are processed normally. This is a residual,
not a code path to fix unless Lemon Squeezy later signs a timestamp. Related:
[replaying old provider events works, even past the retention window](/reference/gotchas#replaying-old-stripe-events-works-even-past-30-days).

## Reporting satellite: failure modes and recovery

**Cross-tenant guard.** Every `ReportingService` method calls
`assertNotInTenantScope()` before issuing SQL: a query that runs inside a
`tenancy.run()` scope throws immediately (no SQL), so reporting can never leak
another tenant's data into a tenant context. The guard is pure and unit-tested.

**Aggregation is read-only over the backoffice schema.** Reporting never enters a
tenant's `search_path`; it aggregates the shared `tenant_metrics` /
`tenant_custom_metrics` tables. SQL is parameterized, the period bucket and the
custom-metric aggregation come from whitelists, and metric names are validated,
so a crafted `since`, `period`, `name`, or `aggregation` cannot inject SQL.

**Concurrent writes during a read are consistent.** PostgreSQL MVCC gives each
aggregation a snapshot as of its start; a write that begins after the read started
is invisible to it. The chaos suite fires concurrent reads interleaved with writes
and asserts every result stays internally consistent (`errors ≤ requests`,
`errorRate ∈ [0,1]`).

**Soft-deleted and missing tenants.** `iterateTenantsByUsage` hydrates with
`includeDeleted: true`, so a soft-deleted tenant still appears in historical
reports; a metric row whose tenant row no longer exists is skipped, not fatal.

**Postgres outage fails clean (no resilience wrap, by design).** Reporting reads
Postgres, not Redis; the Redis-scoped `config.resilience` policies don't apply.
A database outage surfaces as a rejected query (no hang, no partial or
cross-tenant result, the pool released), acceptable for a backoffice/admin tool.
Recovery is automatic once the database is back.

**`emitMetric` is fail-open.** Recording a custom metric never throws on a Redis
hiccup (matching `config.resilience.redis.metrics` default `'fail-open'`); a bad
metric name or non-integer value is a programming error and fails loud instead.

**Report extensions own their own resilience.** The built-in guarantees above
cover the built-in aggregations. A host `ReportExtension` that fans out across
tenant schemas must bound its own concurrency and tolerate per-tenant failures
(see [Scaling limits](/guides/scaling-limits)).

## Read next

- [Configuration → Resilience](/reference/configuration#resilience-degradation-policy)
- [Exception reference](/reference/exceptions)
- [Troubleshooting → fail-open quotas](/reference/gotchas#fail-open-quotas-silently-stop-enforcing)
- [Quotas](/guides/satellites/quotas)
