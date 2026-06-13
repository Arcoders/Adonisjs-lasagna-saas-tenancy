---
title: FAQ
description: Common questions about database support, isolation drivers, scaling, replicas, and production readiness.
---

# FAQ

## Does it work with MySQL or MariaDB?

Not in 1.0. The package is PostgreSQL-only today: schema-per-tenant and database-per-tenant lean
on Postgres-native concepts, and `rowscope-pg` uses PostgreSQL Row-Level Security for its hard
boundary. MySQL is planned as a future opt-in satellite driver (see the [roadmap](/docs/roadmap)),
built on the [custom isolation driver](/docs/cookbook/custom-isolation-driver) extension point. It
would carry explicit caveats: database-per-tenant only, with no schema-per-tenant equivalent and no
native RLS, so the `rowscope-pg` database-level boundary would not carry over. If you need MySQL
today, use another package such as `stancl/tenancy` (Laravel).

## Which isolation driver should I choose?

- **`schema-pg`** (default): one Postgres schema per tenant. Strong at-rest separation and
  per-tenant migrations. The right default for most SaaS.
- **`database-pg`**: one database per tenant. Maximum isolation; heaviest on connections.
- **`rowscope-pg`**: one shared schema, isolated by a `tenant_id` column plus optional RLS.
  Lightest on connections; best for very large tenant counts.

See [Data isolation](/docs/data-isolation/) for the trade-offs and
[Scaling limits](/docs/scaling-limits) for how each scales with tenant count.

## Can I change isolation drivers after launch?

Not as a config flip. Each driver stores tenant data in a different physical layout
(separate schemas, separate databases, or a shared table with a `tenant_id`), so switching
means migrating data between layouts. There is no built-in driver-to-driver migration tool.
Pick the driver deliberately up front; treat a later change as a planned data migration.

## How many tenants can I run?

It depends on the driver and your connection budget, not on a fixed cap. `schema-pg` and
`database-pg` are bounded by connection and catalog pressure; `rowscope-pg` scales to far
more tenants because they share one connection pool. The [Scaling limits](/docs/scaling-limits)
page has the sizing guidance and the connection-budget math.

## Do I need Redis?

For production, effectively yes. Redis backs the circuit breaker's persisted state, the
rate limiter, quota counters, the cache bootstrapper, and the queue. The
[resilience](/docs/resilience) policy controls what happens when a dependency like Redis is
down (fail-open vs fail-closed) so an outage degrades predictably rather than crashing.

## Can I run read replicas, or across regions?

Yes. Read-replica routing supports round-robin, random, and sticky-by-tenant-id selection
with stable connection naming. By design there is **no automatic failover**: use the
retry-on-primary pattern. See [Read replicas](/docs/read-replicas) and the
[multi-region cookbook](/docs/cookbook/multi-region-replicas).

## Can a tenant model relate to a central or backoffice model?

Not through a Lucid relationship or a foreign key: those layers live on different schemas
(and, for `database-pg`, different databases), and relationships resolve on a single
connection. Store the other layer's id as a plain column and load it explicitly. See
[Models, cross-layer relationships](/docs/models#cross-layer-relationships).

## Is 1.0.0 production ready?

The isolation core is **release candidate**: feature complete and green in CI against real
Postgres and Redis. The `stable` label is withheld until an independent security review and
production mileage close. The satellites are **experimental**. Read the full
[stability matrix](/docs/stability) and the [security guide](/security) before adopting, and
pin your version.

## How do I test an app built on this?

The package ships testing helpers (`buildTestTenant`, `MockTenantRepository`,
`setRequestTenant`, `withTenant`) plus an in-memory `sqlite-memory` driver for fast unit
tests. See [Testing](/docs/testing).

## Read next

- [Troubleshooting](/docs/gotchas); fixes for the sharp edges.
- [Known limitations](/docs/known-limitations); the deliberate non-goals.
- [Comparison](/docs/comparison); how it stacks up against stancl and NestJS.
