---
title: Configuration reference
description: Every config/multitenancy.ts option, with its type, default, and meaning, in one place. Covers the resilience degradation policy, isolation, circuit breaker, quotas, backups, billing, replicas, and doctor thresholds.
---

# Configuration reference

All configuration lives in `config/multitenancy.ts`, wrapped in `defineConfig()`
so TypeScript checks the shape at build time. The stub the installer copies is a
good starting point; this page is the exhaustive reference.

```ts
import { defineConfig } from '@adonisjs-lasagna/saas-tenancy'

export default defineConfig({
  // …see the sections below
})
```

::: tip
`getConfig()` throws until `MultitenancyProvider` has booted. That's the
intended guard. Read config at request or job time, not at module top-level.
:::

## Core

| Key | Type | Default | Meaning |
|---|---|---|---|
| `backofficeSchemaName` | `string` |  | PG schema holding shared/satellite data. |
| `backofficeConnectionName` | `string` |  | Lucid connection used for the backoffice schema. |
| `centralSchemaName` | `string` |  | Schema for central/global (non-tenant) tables. |
| `centralConnectionName` | `string` |  | Lucid connection for the central schema. |
| `tenantConnectionNamePrefix` | `string` |  | Prefix for per-tenant Lucid connection names (`<prefix><tenantId>`). |
| `tenantSchemaPrefix` | `string` |  | Prefix for per-tenant schema names (`<prefix><tenantId>`). |
| `schemaCacheTtl` | `number` |  | TTL (seconds) for cached schema-existence probes. |
| `ignorePaths` | `string[]` |  | Request paths that skip tenant resolution (health checks, the Stripe webhook, and so on). |

## Tenant resolution

| Key | Type | Default | Meaning |
|---|---|---|---|
| `resolverStrategy` | `'subdomain' \| 'header' \| 'path' \| 'domain-or-subdomain' \| 'request-data'` |  | How the tenant id is read from the request. |
| `resolverChain` | `string[]` |  | Ordered resolver names; first hit wins. **Overrides** `resolverStrategy`. |
| `tenantHeaderKey` | `string` |  | Header name read by the `header` resolver. |
| `baseDomain` | `string` |  | Apex domain used to parse subdomains. |
| `requestData.queryKey` | `string` | `'tenant_id'` | Query-string key for the `request-data` resolver. |
| `requestData.bodyKey` | `string` | `'tenant_id'` | Body key for the `request-data` resolver. |

::: warning Always resolve via the helper
Never read the tenant header directly. Call `resolveTenantId(request)`, which
honours `resolverStrategy` and `resolverChain` so a strategy change doesn't
silently bypass your code. See [Troubleshooting](./gotchas).
:::

## Isolation

```ts
isolation: { driver: 'schema-pg' }
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `isolation.driver` | `'schema-pg' \| 'database-pg' \| 'rowscope-pg' \| 'sqlite-memory'` | `'schema-pg'` | Isolation strategy. |
| `isolation.templateConnectionName` | `string` | `'tenant'` | Connection whose config is cloned per tenant (`schema-pg`/`database-pg`). |
| `isolation.tenantDatabasePrefix` | `string` | `'tenant_'` | Per-tenant database name prefix (`database-pg`). |
| `isolation.rowScopeTables` | `string[]` |  | Tenant-scoped tables (`rowscope-pg`) for `destroy`/`reset`. |
| `isolation.rowScopeColumn` | `string` | `'tenant_id'` | Tenant id column (`rowscope-pg`). |
| `isolation.rowScopeMode` | `'strict' \| 'allowGlobal'` | `'strict'` | `strict` throws on an unscoped query outside `tenancy.run()`. This is the safe default. |

## Resilience (degradation policy)

Decides, per backing dependency, whether an outage fails **open** (skip the
check, stay available) or **closed** (return `503`). Consumed by
`ResilienceService`; emits a `DependencyDegraded` event on every degradation.

```ts
resilience: {
  redis: { quota: 'fail-open', rateLimit: 'fail-closed' },
  observe: true,
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `resilience.defaultPolicy` | `'fail-open' \| 'fail-closed'` | `'fail-closed'` | Fallback policy for anything not overridden. |
| `resilience.redis.quota` | `'fail-open' \| 'fail-closed'` | `'fail-open'` | `QuotaService.consume/track` on a Redis outage. Fail-open returns `0` (no enforcement); fail-closed throws `DependencyUnavailableException`. |
| `resilience.redis.rateLimit` | `'fail-open' \| 'fail-closed'` | `'fail-closed'` | `RateLimitMiddleware` (the per-route `failOpen` option still wins where set). |
| `resilience.redis.cache` | `'fail-open' \| 'fail-closed'` | `'fail-open'` | Cache bootstrapper. |
| `resilience.redis.metrics` | `'fail-open' \| 'fail-closed'` | `'fail-open'` | `MetricsService` counters. |
| `resilience.observe` | `boolean` | `true` | Emit `DependencyDegraded` + log + OTel span event on degradation. |

::: warning Fail-open is silent enforcement loss
`fail-open` for quotas means a Redis outage stops enforcing limits. That's the
right default for availability, but subscribe to `DependencyDegraded` so you
**know** it's happening. Choose `fail-closed` where correctness beats uptime.
:::

## Circuit breaker

| Key | Type | Meaning |
|---|---|---|
| `circuitBreaker.threshold` | `number` | Error-percentage threshold to open. |
| `circuitBreaker.resetTimeout` | `number` | ms in OPEN before probing (HALF_OPEN). |
| `circuitBreaker.rollingCountTimeout` | `number` | ms window for the rolling error stats. |
| `circuitBreaker.volumeThreshold` | `number` | Minimum requests in the window before the breaker can trip. |

Open/closed state is persisted to Redis and **restored on restart** so a
known-down tenant DB isn't hammered with timeouts after a deploy.

## Queue, cache, backup

| Key | Type | Default | Meaning |
|---|---|---|---|
| `queue.tenantQueuePrefix` | `string` |  | BullMQ queue-name prefix per tenant. |
| `queue.defaultConcurrency` | `number` |  | Default worker concurrency. |
| `queue.attempts` | `number` |  | Default job retry attempts. |
| `queue.redis` | `{ host, port, username?, password?, db? }` |  | Dedicated Redis for queues (separate DB from `cache.redis`). |
| `cache.ttl` | `number` |  | Default cache TTL (seconds). |
| `cache.redis` | `{ host, port, username?, password?, db? }` |  | Dedicated Redis for the cache. |
| `backup.storagePath` | `string` |  | Local dir for `.dump` archives + `backup.json` sidecar. |
| `backup.metadataTtl` | `number` |  | TTL (seconds) for backup metadata in Redis. |
| `backup.pgConnection` | `{ host, port, user, password, database }` |  | Connection used by `pg_dump`/`pg_restore`/`psql`. |
| `backup.s3` | `{ enabled, bucket, region, endpoint?, accessKeyId, secretAccessKey }` |  | Optional S3 offload (peer dep `@aws-sdk/client-s3`). |
| `backup.retention` | `BackupRetentionConfig` |  | Tiered retention (`tiers`, `defaultTier`, `getTier`). |

## Plans & billing

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plans.defaultPlan` | `string` |  | Plan applied when nothing else resolves. |
| `plans.definitions` | `Record<string, { limits: Record<string, number> }>` |  | Named plans and their quota limits. |
| `plans.getPlan` | `(tenant) => string \| undefined` |  | Host callback to resolve a tenant's plan. |
| `plans.storage` | `'config-only' \| 'tenant_plans' \| 'auto'` | `'auto'` | Where the tenant→plan assignment lives. |
| `plans.emitTracked` | `boolean` | `false` | Emit `QuotaTracked` on every `track`/`consume` (enables the Stripe metering bridge). |
| `billing` | `BillingConfig` |  | Stripe satellite. See the [Billing](./satellites/billing) page for the full block. |

## Impersonation, maintenance, soft delete

| Key | Type | Default | Meaning |
|---|---|---|---|
| `impersonation.secret` | `string` |  | HMAC secret (≥ 32 chars). Without it, `start()` throws. |
| `impersonation.defaultDuration` | `number` | `3600` | Session length (seconds, min 60). |
| `impersonation.maxDuration` | `number` | `86400` | Hard upper bound (seconds). |
| `impersonation.headerName` | `string` | `x-impersonation-token` | Header read by the middleware. |
| `impersonation.cookieName` | `string` | `__impersonation` | Cookie fallback name. |
| `maintenance.defaultMessage` | `string` |  | Default body for `TenantMaintenanceException`. |
| `maintenance.retryAfterSeconds` | `number` | `600` | `Retry-After` on the 503. |
| `maintenance.bypassToken` / `bypassHeader` | `string` | `x-tenant-bypass-maintenance` | Shared-secret bypass. Rotate often. |
| `softDelete.retentionDays` | `number` | `30` | Days a soft-deleted tenant's schema survives before `tenant:purge-expired` drops it. |

## Doctor thresholds

`doctor` overrides the built-in `tenant:doctor` check thresholds (all optional):
`queueStalledMinutes` (10), `replicaLagWarnSeconds` (30), `replicaLagErrorSeconds`
(120), `longQueryWarnSeconds` (30), `longQueryErrorSeconds` (120),
`poolSaturationWarnRatio` (0.9).

## Read replicas

```ts
tenantReadReplicas: { hosts: [{ host: 'replica-1' }], strategy: 'sticky' }
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `tenantReadReplicas.hosts` | `{ host, port?, user?, password?, name? }[]` |  | Pool of read replicas. |
| `tenantReadReplicas.strategy` | `'round-robin' \| 'random' \| 'sticky'` | `'round-robin'` | How a replica is chosen per request. |
| `tenantReadReplicas.connectionSuffix` | `string` | `'_read'` | Suffix for the registered replica connection name. |

::: warning No automatic lag failover
Replica selection does **not** check lag or health. Reads can be stale, and a
down replica isn't auto-skipped. Route latency-sensitive reads to the primary,
or add your own health gate. See [Troubleshooting](./gotchas).
:::
