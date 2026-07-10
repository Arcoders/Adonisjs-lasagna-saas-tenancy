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
| `centralConnectionName` | `string` |  | Lucid connection for the central schema; also the shared connection for `rowscope-pg`. |
| `tenantConnectionNamePrefix` | `string` |  | Prefix for per-tenant Lucid connection names (`<prefix><tenantId>`). |
| `tenantSchemaPrefix` | `string` |  | Prefix for per-tenant schema names (`<prefix><tenantId>`). |
| `schemaCacheTtl` | `number` |  | TTL (seconds) for cached schema-existence probes. |
| `ignorePaths` | `string[]` |  | Request paths that skip tenant resolution (health checks, the Stripe webhook, and so on). |

## Tenant resolution

| Key | Type | Default | Meaning |
|---|---|---|---|
| `resolverStrategy` | `'subdomain' \| 'header' \| 'path' \| 'domain-or-subdomain' \| 'request-data'` |  | How the tenant id is read from the request. |
| `resolverChain` | `Array<string \| TenantResolver>` |  | Ordered resolvers; first hit wins. **Overrides** `resolverStrategy`. Each entry is a built-in name, the name of an instance from `resolvers`, or an inline `TenantResolver`. Unknown names fail at boot. |
| `resolvers` | `TenantResolver[]` |  | Custom `TenantResolver` instances registered at boot so they can be referenced by name in `resolverChain`. |
| `resolver.legacyAdapterFallback` | `boolean` | `false` | Restore the 0.x `resolverStrategy`-only fallback for model queries outside an active tenant context. See [Upgrade to 0.3](/reference/upgrade-to-0.3#_3-check-the-resolver-default). |
| `resolver.cache.enabled` | `boolean` | `false` | Opt-in per-process cache of resolved tenants — cuts the steady-state backoffice round-trips per request from two to one. The cached tenant is the SAME instance for every concurrent request: treat it as read-only. See [Performance](/guides/performance). |
| `resolver.cache.ttlMs` | `number` | `10000` | Freshness bound per entry; also the cross-pod staleness bound for a status change (in-process invalidation fires when the matching lifecycle event is emitted). |
| `resolver.cache.maxEntries` | `number` | `10000` | LRU cap on simultaneously-cached tenants per process. |
| `tenantHeaderKey` | `string` |  | Header name read by the `header` resolver. |
| `baseDomain` | `string` |  | Apex domain used to parse subdomains. |
| `requestData.queryKey` | `string` | `'tenant_id'` | Query-string key for the `request-data` resolver. |
| `requestData.bodyKey` | `string` | `'tenant_id'` | Body key for the `request-data` resolver. |

::: warning Always resolve via the helper
Never read the tenant header directly. Call `resolveTenantId(request)`, which
honours `resolverStrategy` and `resolverChain` so a strategy change doesn't
silently bypass your code. See [Troubleshooting](/reference/gotchas).
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
| `isolation.rowScopeRls` | `boolean` | `false` | Acknowledges the PostgreSQL RLS backstop is applied (`--with=rls` migration + `withTenantRls`). Until set, the provider logs a boot warning that bare `rowscope-pg` is convention-isolated. See [rowscope-pg](/guides/data-isolation/rowscope-pg). |
| `isolation.maxTenantConnections` | `number` | `50` | LRU budget for open tenant connections (`schema-pg`/`database-pg`). Keep `cap × pool max` under PG's `max_connections`. |
| `isolation.evictionGracePeriodMs` | `number` | `30000` | A connection touched more recently than this is in-use and never evicted — set above your p99 request duration. |
| `isolation.enforceConnectionCap` | `boolean` | `false` | Turn the LRU budget into a hard cap: refuse new tenant connections with a 503 (`TenantConnectionLimitException`) instead of exceeding it. |

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
| `resilience.redis.quota` | `'fail-open' \| 'fail-closed'` | `'fail-open'` | `QuotaService.consume/track` on a Redis outage. Fail-open returns `0` (no enforcement); fail-closed throws `DependencyUnavailableException`. |
| `resilience.redis.rateLimit` | `'fail-open' \| 'fail-closed'` | `'fail-closed'` | `RateLimitMiddleware` (an explicit per-route `failOpen` option still wins). |
| `resilience.observe` | `boolean` | `true` | Emit `DependencyDegraded` + log + OTel span event on degradation. |
| `resilience.defaultPolicy`, `resilience.redis.cache`, `resilience.redis.metrics` | — | reserved | Typed but **not consulted yet**: the cache bootstrapper and `MetricsService` currently always fail open, and there is no generic default-policy fan-out. Reserved for a future release. |

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
| `backup.lockFailOpenOnDestructive` | `boolean` | `false` | When Redis (the lock layer) is unreachable, destructive ops (restore/clone/import) fail **closed** by default. Set `true` to restore the legacy fail-open behaviour. The read-only `backup` always fails open. |

## Plans & billing

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plans.defaultPlan` | `string` |  | Plan applied when nothing else resolves. |
| `plans.definitions` | `Record<string, { limits: Record<string, number> }>` |  | Named plans and their quota limits. |
| `plans.getPlan` | `(tenant) => string \| undefined` |  | Host callback to resolve a tenant's plan. |
| `plans.storage` | `'config-only' \| 'tenant_plans' \| 'auto'` | `'auto'` | Where the tenant→plan assignment lives. |
| `plans.emitTracked` | `boolean` | `false` | Emit `QuotaTracked` on every `track`/`consume` (enables the Stripe metering bridge). |
| `billing` | `BillingConfig` |  | Stripe satellite. See the [Billing](/guides/satellites/billing) page for the full block. |

## Impersonation, maintenance, soft delete

| Key | Type | Default | Meaning |
|---|---|---|---|
| `impersonation.secret` | `string` |  | HMAC secret (≥ 32 chars). Without it, `start()` throws. |
| `impersonation.defaultDuration` | `number` | `900` | Session length (seconds, min 60). |
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

`includeQueryText` (default `false`) controls whether the `long_running_queries`
check puts the **raw SQL text** of a slow query in its diagnosis `meta`. It is off
by default because that text can carry another tenant's secrets or PII as SQL
literals, and the Doctor report is reachable over HTTP at the admin
`/health/report` surface; off, the check emits only a non-reversible
`queryFingerprint` so operators can still correlate queries. Turn it on only for
trusted local CLI diagnosis.

## Routing, scheduling, onboarding, hooks

| Key | Type | Default | Meaning |
|---|---|---|---|
| `routing.autoLoad` | `boolean` | `true` | Auto-import `start/tenant.ts` and `start/universal.ts` after the router macros install. |
| `routing.tenantRoutesFile` | `string` | `'tenant.ts'` | Filename inside `start/` for tenant routes. |
| `routing.universalRoutesFile` | `string` | `'universal.ts'` | Filename inside `start/` for universal routes. |
| `maintenanceSchedule.backupHour` | `number` |  | Hour of day (UTC) the host's scheduler should run backups at. |
| `maintenanceSchedule.migrateAllHour` | `number` |  | Hour of day (UTC) for whole-fleet migrations. |
| `onboarding.wizardTtl` / `onboarding.wizardKeyPrefix` | `number` / `string` |  | Cache TTL and key prefix for an onboarding-wizard flow, if your app uses one. |
| `hooks` | `DeclarativeHooks` |  | Lifecycle callbacks (`beforeProvision`, `afterMigrate`, …). See [Hooks](/reference/hooks). |

## Plugin platform

Caps and tuning for the [plugin platform](/guides/plugins) (the `definePlugin`
facade and its request-path seams). The whole block is optional; omit it to run
the plugin surfaces uncapped with the default authorizer deadline.

```ts
plugins: {
  limits: {
    maxAuthorizers: 16,
    maxMiddleware: 16,
    maxCapabilities: 64,
    authorizerDeadlineMs: 1000,
  },
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.limits.maxAuthorizers` | `number` | unlimited | Cap on registered tenant-access authorizers. |
| `plugins.limits.maxMiddleware` | `number` | unlimited | Cap on registered plugin route middleware. |
| `plugins.limits.maxCapabilities` | `number` | unlimited | Cap on provided capabilities. |
| `plugins.limits.authorizerDeadlineMs` | `number` | `1000` | Response deadline (ms) for a single plugin authorizer before it is treated as a DENY (fail-closed). A deadline, not cancellation. |

The `max*` caps are **fail-closed and enforced once at boot**: after every plugin
has registered, a surface whose count exceeds its cap aborts the deploy with a
`PluginBootException`, so a runaway or hostile plugin can't quietly bloat the
per-request chain. An omitted cap means unlimited (byte-identical to the pre-cap
behavior). A cap of `0` (or a negative / non-finite value) is a config mistake and
fails boot via the bounds check.

## Read replicas

```ts
tenantReadReplicas: { hosts: [{ host: 'replica-1' }], strategy: 'sticky' }
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `tenantReadReplicas.hosts` | `{ host, port?, user?, password?, name? }[]` |  | Pool of read replicas. |
| `tenantReadReplicas.strategy` | `'round-robin' \| 'random' \| 'sticky'` | `'round-robin'` | How a replica is chosen per request. |
| `tenantReadReplicas.connectionSuffix` | `string` | `'_read'` | Suffix for the registered replica connection name. |
| `tenantReadReplicas.maxReplicaConnections` | `number` | `50` | Separate LRU budget for replica connections (they multiply by host). |

::: warning No automatic lag failover
Replica selection does **not** check lag or health. Reads can be stale, and a
down replica isn't auto-skipped. Route latency-sensitive reads to the primary,
or add your own health gate. See [Troubleshooting](/reference/gotchas).
:::

## WebSockets

Read by the `@adonisjs-lasagna/websockets` satellite from the `websockets` block, and
validated at boot. The core never reads it; apps without the satellite omit it. See the
[WebSockets satellite](/guides/satellites/websockets) for the full guide.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `websockets.path` | `string` | socket.io default (`/socket.io`) | Mount path for the socket.io endpoint. |
| `websockets.cors` | `ServerOptions['cors']` |  | Passed straight to socket.io's `cors` option. |
| `websockets.handshake.authKey` | `string \| false` | `'tenantId'` | Key read from `handshake.auth`; `false` disables this source. |
| `websockets.handshake.headerKey` | `string \| false` | core `tenantHeaderKey` | Header read for the tenant id; `false` disables. |
| `websockets.handshake.queryKey` | `string \| false` | `false` | Query-param read for the tenant id; set a name to enable. |
| `websockets.handshake.subdomain` | `boolean` | `false` | Derive the tenant from the leftmost `Host` label. |
| `websockets.handshake.baseDomain` | `string` |  | Base domain stripped when `subdomain` is on. |
| `websockets.authorize` | `(socket, tenant) => boolean \| Promise<boolean>` |  | Optional handshake gate; a falsy return (or throw) rejects the connection. |

## Read next

- [CLI commands](/reference/commands); the ace surface that reads this config.
- [Hooks](/reference/hooks); the lifecycle callbacks you register here.
- [Resilience](/guides/resilience); the degradation-policy block, explained.
