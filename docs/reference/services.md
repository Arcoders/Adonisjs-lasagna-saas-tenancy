---
title: Service API reference
description: Method signatures and behavior for the in-core leaf-satellite services (quotas, audit, webhooks, branding, feature flags, metrics).
---

# Service API reference

A signature-level reference for the in-core services. Each one is registered in the
IoC container, so resolve it with `app.container.make(...)`:

```ts
import app from '@adonisjs/core/services/app'
import { QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'

const quotas = await app.container.make(QuotaService)
```

::: tip Stability
These satellite services are **experimental** per the [stability matrix](/reference/stability):
covered by tests, but the surface may change in a minor. Pin your version. The isolation
core they sit on is `release-candidate`.
:::

For prose, examples, and storage details see each feature page; this page is the quick
method lookup.

::: info Core services live on their own pages
This reference covers the leaf-satellite services. The cross-cutting core services are
documented where they're used: [`ResilienceService`](/guides/resilience),
[`ReadReplicaService`](/guides/read-replicas), [`DoctorService`](/guides/health),
[`ComplianceReportService`](/guides/compliance), [`TenantLogContext` and
`tenantLogger`](/guides/contextual-logging), and the [isolation drivers and
resolvers](/guides/data-isolation/).
:::

## QuotaService

Plan-bound, atomic per-tenant counters. See [Quotas](/guides/satellites/quotas).

| Method | Returns | Notes |
|---|---|---|
| `consume(tenant, quota, amount = 1)` | `Promise<number>` | Atomically increments; throws `QuotaExceededException` (429) on overrun. Returns the new usage. |
| `track(tenant, quota, amount = 1)` | `Promise<number>` | Increments without enforcing a limit (soft-warn). |
| `check(tenant, quota, amount?)` | `Promise<QuotaCheckResult>` | Non-mutating: would this consume be allowed? |
| `getUsage(tenant, quota)` | `Promise<number>` | Current usage. |
| `setUsage(tenant, quota, value)` | `Promise<void>` | Overwrite the counter. |
| `reset(tenant, quota?)` | `Promise<void>` | Reset one quota, or all for the tenant. |
| `getLimit(tenant, quota)` | `Promise<number>` | The resolved plan's limit for a quota. |
| `getPlanFor(tenant)` | `Promise<{ name, plan }>` | The tenant's resolved plan definition. |
| `assignPlan(tenant, plan, ...)` | `Promise<…>` | Persist a plan assignment. |
| `getAssignedPlan(tenantId)` / `clearAssignedPlan(tenantId)` | `Promise<string \| null>` / `Promise<void>` | Read/clear a stored assignment. |
| `snapshot(tenant)` | `Promise<QuotaStateSnapshot>` | All quotas + usage at once. |

Redis-dependent calls route through `ResilienceService`, so a Redis outage degrades per
the configured [resilience](/guides/resilience) policy rather than throwing raw.

## AuditLogService

Append-only audit trail in the backoffice schema. See [Audit](/guides/satellites/audit).

| Method | Returns |
|---|---|
| `log({ action, tenantId?, actorType?, actorId?, metadata?, ipAddress? })` | `Promise<TenantAuditLog>` |
| `listForTenant(tenantId, page = 1, limit = 50, { from?, to? } = {})` | `Promise<…>` (serialized paginator; `limit` capped at 200) |

## WebhookService

Outbound webhooks with HMAC signing and retries. See [Webhooks](/guides/satellites/webhooks).

| Method | Returns | Notes |
|---|---|---|
| `dispatch(tenantId, event, payload)` | `Promise<void>` | Fan out an event to every enabled hook subscribed to it. |
| `registerWebhook(tenantId, url, events, secret?)` | `Promise<{ hook, generatedSecret? }>` | Validates the URL against the SSRF guard before persisting. `generatedSecret` is the one-time plaintext, present only when `secret` was omitted. |
| `listWebhooks(tenantId)` / `deleteWebhook(id, tenantId)` | `Promise<TenantWebhook[]>` / `Promise<void>` | |
| `processRetries()` | `Promise<void>` | Send all deliveries whose `next_retry_at` is due (used by the retry sweep). |

The module also exports the pure receiver-side helper
`verifyWebhookSignature(rawBody, signatureHeader, secret): boolean`, a constant-time check
your endpoints should use rather than rolling their own.

## BrandingService

Per-tenant branding, cached. See [Branding](/guides/satellites/branding).

| Method | Returns |
|---|---|
| `getForTenant(tenantId)` | `Promise<TenantBranding \| null>` (cached 300s) |
| `upsert(tenantId, data: BrandingData)` | `Promise<TenantBranding>` (busts the cache) |
| `renderEmailContext(branding)` | a plain object of email fields with sane fallbacks |

## FeatureFlagService

Boolean per-tenant flags. See [Feature flags](/guides/satellites/feature-flags).

| Method | Returns |
|---|---|
| `isEnabled(tenantId, flag)` | `Promise<boolean>` (false when absent; cached 60s) |
| `set(tenantId, flag, enabled, config?)` | `Promise<TenantFeatureFlag>` |
| `listForTenant(tenantId)` / `delete(tenantId, flag)` | `Promise<TenantFeatureFlag[]>` / `Promise<void>` |

## MetricsService

Fixed per-tenant counters. See [Metrics](/guides/satellites/metrics).

| Method | Returns |
|---|---|
| `increment(tenantId, 'requests' \| 'errors', amount = 1)` | `Promise<void>` |
| `trackBandwidth(tenantId, bytes)` | `Promise<void>` |
| `flush(period?)` | `Promise<void>` (rolls Redis counters into `tenant_metrics`) |
| `getForTenant(tenantId, days = 30)` | `Promise<TenantMetric[]>` |

Unlike `QuotaService`, `increment` and `trackBandwidth` `await` Redis directly with
no resilience wrapper, so they reject on a Redis outage rather than degrading; catch
at the call site if the write should be best-effort (see
[Metrics caveats](/guides/satellites/metrics#caveats)).

## CircuitBreakerService

Per-tenant database circuit breaker. Trips to `OPEN` when a tenant's connection fails past
the configured threshold, fails fast while open, and persists state across restarts via
Redis. See [Resilience](/guides/resilience) and [Health](/guides/health).

| Method | Returns | Notes |
|---|---|---|
| `getCircuit(tenantId)` | `CircuitBreaker` | The breaker for a tenant, created lazily on first access. |
| `isOpen(tenantId)` | `boolean` | Whether the tenant's circuit is currently failing fast. |
| `getMetrics(tenantId)` | `CircuitMetrics \| null` | State + failure/success/fallback counts for one tenant (null if no breaker). |
| `getAllMetrics()` | `Record<string, CircuitMetrics>` | Metrics for every tracked breaker, keyed by tenant id. Feeds the health check. |
| `reset(tenantId)` | `void` | Force-close a breaker and clear its error state. |
| `destroy(tenantId)` | `Promise<void>` | Shut down a breaker and drop its persisted state. |

## TenantQueueService

Per-tenant BullMQ access. Keeps a bounded pool of dispatch-path queue handles (one Redis
connection each) and uses short-lived handles for read-only inspection. See
[Background jobs](/guides/jobs).

| Method | Returns | Notes |
|---|---|---|
| `dispatch(tenantId, jobName, payload, opts?)` | `Promise<void>` | Enqueue a job for a tenant, with optional BullMQ `JobsOptions`. |
| `getStats(tenantId)` | `Promise<TenantQueueStats>` | Job counts (waiting/active/completed/failed/delayed) via a temporary handle. |
| `statsForTenants(tenantIds, concurrency?)` | `Promise<TenantQueueStats[]>` | Stats for an explicit list, in bounded-concurrency batches. |
| `getAllStats()` | `Promise<TenantQueueStats[]>` | Stats for every tenant this process has dispatched to. |
| `getQueueName(tenantId)` | `string` | The computed BullMQ queue name for a tenant. |
| `openHandleCount` | `number` (getter) | Open dispatch handles, bounded by `queue.maxOpenQueues`. |
| `destroy(tenantId)` | `Promise<void>` | Obliterate a tenant's queue and close its handle. |

## Read next

- [Exceptions](/reference/exceptions); the typed errors these services throw.
- [Lifecycle events](/reference/events); what the services emit as they run.
- [Configuration](/reference/configuration); the options that tune them.
