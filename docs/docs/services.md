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
These satellite services are **experimental** per the [stability matrix](/docs/stability):
covered by tests, but the surface may change in a minor. Pin your version. The isolation
core they sit on is `release-candidate`.
:::

For prose, examples, and storage details see each feature page; this page is the quick
method lookup.

## QuotaService

Plan-bound, atomic per-tenant counters. See [Quotas](/docs/satellites/quotas).

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
the configured [resilience](/docs/resilience) policy rather than throwing raw.

## AuditLogService

Append-only audit trail in the backoffice schema. See [Audit](/docs/satellites/audit).

| Method | Returns |
|---|---|
| `log({ action, tenantId?, actorType?, actorId?, metadata?, ipAddress? })` | `Promise<TenantAuditLog>` |
| `listForTenant(tenantId, page = 1, limit = 50, { from?, to? } = {})` | `Promise<…>` (serialized paginator; `limit` capped at 200) |

## WebhookService

Outbound webhooks with HMAC signing and retries. See [Webhooks](/docs/satellites/webhooks).

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

Per-tenant branding, cached. See [Branding](/docs/satellites/branding).

| Method | Returns |
|---|---|
| `getForTenant(tenantId)` | `Promise<TenantBranding \| null>` (cached 300s) |
| `upsert(tenantId, data: BrandingData)` | `Promise<TenantBranding>` (busts the cache) |
| `renderEmailContext(branding)` | a plain object of email fields with sane fallbacks |

## FeatureFlagService

Boolean per-tenant flags. See [Feature flags](/docs/satellites/feature-flags).

| Method | Returns |
|---|---|
| `isEnabled(tenantId, flag)` | `Promise<boolean>` (false when absent; cached 60s) |
| `set(tenantId, flag, enabled, config?)` | `Promise<TenantFeatureFlag>` |
| `listForTenant(tenantId)` / `delete(tenantId, flag)` | `Promise<TenantFeatureFlag[]>` / `Promise<void>` |

## MetricsService

Fixed per-tenant counters. See [Metrics](/docs/satellites/metrics).

| Method | Returns |
|---|---|
| `increment(tenantId, 'requests' \| 'errors', amount = 1)` | `Promise<void>` |
| `trackBandwidth(tenantId, bytes)` | `Promise<void>` |
| `flush(period?)` | `Promise<void>` (rolls Redis counters into `tenant_metrics`) |
| `getForTenant(tenantId, days = 30)` | `Promise<TenantMetric[]>` |

## Read next

- [Exceptions](/docs/exceptions); the typed errors these services throw.
- [Lifecycle events](/docs/events); what the services emit as they run.
- [Configuration](/docs/configuration); the options that tune them.
