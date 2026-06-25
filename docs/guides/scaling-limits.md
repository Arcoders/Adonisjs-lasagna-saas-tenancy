---
title: Scaling limits
description: The honest ceiling of schema-per-tenant on PostgreSQL, the connection budget, and when to shard or switch drivers.
---

# Scaling limits

Schema-per-tenant is the right default for most SaaS, but it is not free at
high tenant counts. This page is the honest version of where the ceiling is so
you can plan before you hit it.

::: warning Size for active tenants, not for the cap
The single most important sizing fact: **open connections scale with
concurrently *active* tenants, not with `maxTenantConnections`.** The default
soft cap never severs a connection inside the 30 s grace window, so a burst of
N active tenants opens ~N pools, bounded only by PostgreSQL `max_connections`,
and exhausting `max_connections` takes down everything, not just the burst.
Size `max_connections` for your peak concurrent-tenant count, front Postgres
with PgBouncer at higher tenant counts, and consider `enforceConnectionCap:
true` when a firm budget matters more than absorbing every burst. The details
are in [the connection budget](#the-connection-budget) below.
:::

## Where the sweet spot ends

`schema-pg` keeps every tenant in its own PostgreSQL schema inside one
database. That gives you at-rest separation and per-tenant migrations on shared
infrastructure. The practical sweet spot is roughly **tens to a few thousand
tenants per database instance**. Past that, three Postgres-level costs grow:

- **Catalog size.** Every schema multiplies `pg_class`, `pg_attribute`, and
  index rows by your per-tenant table count. Thousands of schemas times dozens
  of tables is hundreds of thousands of catalog rows, which slows planning,
  autovacuum, `pg_dump`, and `\dt`-style introspection.
- **Migrate-all and backups are O(N schemas).** `tenant:migrate --all` and the
  backup commands iterate schemas. The wall-clock cost scales linearly with the
  tenant count regardless of how the package parallelizes.
- **Connection fan-out.** You cannot hold an open pool to every tenant at once.
  This is why the driver caps open connections (see below).

If you need to go well beyond a few thousand tenants on one instance, plan to
**shard tenants across multiple database instances** (run several app/DB pairs
and route by tenant), or evaluate `database-pg` for stronger per-tenant
isolation at a higher per-tenant cost.

## The connection budget

Each active tenant connection holds its own pool. `schema-pg` and `database-pg`
bound how many stay open with an in-use-aware LRU:

```ts
// config/multitenancy.ts
isolation: {
  driver: 'schema-pg',
  // Max tenant connections kept open before the oldest IDLE one is evicted.
  // Default 50.
  maxTenantConnections: 50,
  // A connection touched more recently than this (ms) is treated as in-use
  // and is never evicted, even over the cap. Set above your p99 request
  // duration. Default 30000.
  evictionGracePeriodMs: 30_000,
  // Make maxTenantConnections a HARD bound. Off by default. See below.
  enforceConnectionCap: false,
}
```

Budget rule of thumb:

```
peak server connections ≈ maxTenantConnections × poolMax (+ central + backoffice + replicas)
```

Keep that under your PostgreSQL `max_connections` (or your PgBouncer limit). If
your concurrency genuinely needs more than `maxTenantConnections` distinct
tenants in flight at once, the LRU will **exceed the cap rather than sever an
active request**, and log a throttled warning. That is your signal to raise
`maxTenantConnections`, put PgBouncer in front, or scale out.

### Hard cap vs. availability (`enforceConnectionCap`)

The default (`false`) favours availability: when the cap is reached and every
open connection is still inside the grace window, the pool exceeds the cap
rather than sever an in-flight request. Under a burst of more than
`maxTenantConnections` concurrently-active tenants, open connections therefore
trend toward the number of active tenants, not the cap. This is the right
default for most deployments, and it is the behaviour the 1.0 ships with.

Eviction is by recency, not by tenant "noise": when the cap is reached the LRU
drops the connection that has gone *idle* the longest, never the one that has
sent the most queries. It is not a fair-share scheduler — a tenant with many
concurrent requests is protected by the grace window, while a quiet tenant's
connection is reclaimed first. Per-tenant load fairness (rate limits, worker
concurrency) is a separate concern handled elsewhere.

Set `enforceConnectionCap: true` to make the cap a firm ceiling instead: a new
tenant's `connect()` is refused with a `503` (`TenantConnectionLimitException`)
when the cap is full and nothing is evictable, rather than opening connection
N+1. Turn it on when you front PostgreSQL with **PgBouncer**, or whenever a
bounded server-connection budget matters more than serving every burst. Size
`max_connections` for the cap, not for your tenant count.

::: tip Use a connection pooler
At higher tenant counts, front Postgres with **PgBouncer** (transaction
pooling) so the package's per-tenant connections map onto a much smaller set of
real server connections.
:::

## Read replicas

Replica connections multiply by host (`tenants × hosts`). They are capped by
their own budget, separate from the primary cap:

```ts
tenantReadReplicas: {
  hosts: [/* ... */],
  strategy: 'sticky',          // see read-your-writes note below
  maxReplicaConnections: 50,   // default 50
}
```

`round-robin` and `random` spread one tenant's sequential reads across hosts, so
a read right after a write may hit a lagging replica. Use `sticky` (hash of
tenant id → one host) when a tenant needs consistent reads, and route
read-after-write paths to the primary.

## Measured numbers

The claims above are validated empirically by the benchmark suite in
`benchmarks/`. The block below is generated by `npm run bench:report` from the
1.0.0 baseline; see [Performance](/guides/performance) for the full tables.

<!-- BENCH:summary:start -->
**Per-driver HTTP throughput** (steady state, warmed connections):

- `rowscope-pg` tenant read: **732 req/s** (p99 46.0 ms)
- `database-pg` tenant read: **616 req/s** (p99 52.0 ms)
- `schema-pg` tenant read: **609 req/s** (p99 56.0 ms)

**Connection budget** (under the default 30s grace, open connections track N, not the cap; front with PgBouncer):

- _no memory results yet_

_Generated from the latest results; see [Performance](/guides/performance)._
<!-- BENCH:summary:end -->

## Choosing a driver by scale

| Driver | Isolation | Best for | Main ceiling |
|---|---|---|---|
| `schema-pg` (default) | High (per-schema) | Tens to a few thousand tenants | Catalog bloat, O(N) migrate/backup, connection fan-out |
| `database-pg` | Highest (per-database) | Fewer, higher-value tenants | Heavier per-tenant overhead, `CREATEDB` privilege |
| `rowscope-pg` | Lower (query predicate) | Very many small tenants | Isolation depends on `tenancy.run()` / the scope mixin |

See [Data isolation](/guides/data-isolation/) for the full driver comparison.

## High-volume metrics tables

The backoffice `tenant_metrics` / `tenant_custom_metrics` tables grow with
`tenants × days`, so on a large fleet over years they become the biggest backoffice
tables and cross-tenant aggregation slows down. Two host-managed levers, both
documented under [reporting → Scaling the metrics table](/guides/satellites/reporting):

- **Monthly rollup** (`tenant:metrics:rollup`) — pre-aggregate into a
  ~30×-smaller per-tenant monthly table that reporting reads for whole-month windows.
- **RANGE partitioning by `period`** — the package ships a plain table, but because
  every reporting query filters and groups by `period`, partitioning lets the
  planner prune to the months a window touches. Sketch:

  ```sql
  -- host-managed migration (not shipped — keeps the default install simple)
  CREATE TABLE backoffice.tenant_metrics (...) PARTITION BY RANGE (period);
  CREATE TABLE backoffice.tenant_metrics_2026 PARTITION OF backoffice.tenant_metrics
    FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
  ```

  The existing `UNIQUE(tenant_id, period)` already includes the partition key
  `period` (Postgres requires it) — don't reorder it, or partitioning breaks. Use
  attach/detach of yearly child partitions for retention.

## Read next

- [Performance](/guides/performance); the benchmark numbers behind these ceilings.
- [Read replicas](/guides/read-replicas); scaling reads horizontally.
- [Production checklist](/reference/production-checklist); the operational pre-flight.
