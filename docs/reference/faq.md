---
title: FAQ
description: Common questions about database and framework support, isolation drivers, scaling, replicas, and production readiness.
---

# FAQ

## Does it work with MySQL or MariaDB?

No, and that is by design. Lasagna is PostgreSQL-only: schema-per-tenant and database-per-tenant
lean on Postgres-native concepts, and `rowscope-pg` uses PostgreSQL Row-Level Security for its hard
boundary. Supporting another database would mean compromising the parts we consider essential, so we
focus on doing PostgreSQL really well rather than spreading thin across engines. This is a product
decision, not a temporary gap. If you need MySQL today, use another package such as `stancl/tenancy`
(Laravel).

## Does it work with Express, NestJS, or another framework?

No. Lasagna is built only for AdonisJS 7 and leans on its providers, middleware, ace commands, and
container bindings throughout. Supporting other frameworks would mean making the package
framework-neutral and giving up that deep integration, so it is a deliberate non-goal. If you know
AdonisJS, you already know how to use Lasagna.

## Which isolation driver should I choose?

- **`schema-pg`** (default): one Postgres schema per tenant. Strong at-rest separation and
  per-tenant migrations. The right default for most SaaS.
- **`database-pg`**: one database per tenant. Maximum isolation; heaviest on connections.
- **`rowscope-pg`**: one shared schema, isolated by a `tenant_id` column plus optional RLS.
  Lightest on connections; best for very large tenant counts.

See [Data isolation](/guides/data-isolation/) for the trade-offs and
[Scaling limits](/guides/scaling-limits) for how each scales with tenant count.

## Can I change isolation drivers after launch?

Not as a config flip. Each driver stores tenant data in a different physical layout
(separate schemas, separate databases, or a shared table with a `tenant_id`), so switching
means migrating data between layouts. There is no built-in driver-to-driver migration tool.
Pick the driver deliberately up front; treat a later change as a planned data migration.

## How many tenants can I run?

It depends on the driver and your connection budget, not on a fixed cap. `schema-pg` and
`database-pg` are bounded by connection and catalog pressure; `rowscope-pg` scales to far
more tenants because they share one connection pool. The [Scaling limits](/guides/scaling-limits)
page has the sizing guidance and the connection-budget math.

## Do I need Redis?

For production, effectively yes. Redis backs the circuit breaker's persisted state, the
rate limiter, quota counters, the cache bootstrapper, and the queue. The
[resilience](/guides/resilience) policy controls what happens when a dependency like Redis is
down (fail-open vs fail-closed) so an outage degrades predictably rather than crashing.

## Can I run read replicas, or across regions?

Yes. Read-replica routing supports round-robin, random, and sticky-by-tenant-id selection
with stable connection naming. By design there is **no automatic failover**: use the
retry-on-primary pattern. See [Read replicas](/guides/read-replicas) and the
[multi-region cookbook](/guides/cookbook/multi-region-replicas).

## Can a tenant model relate to a central or backoffice model?

Not through a Lucid relationship or a foreign key: those layers live on different schemas
(and, for `database-pg`, different databases), and relationships resolve on a single
connection. Store the other layer's id as a plain column and load it explicitly. See
[Models, cross-layer relationships](/guides/models#cross-layer-relationships).

## Is 1.0.0 production ready?

The isolation core is **release candidate**: feature complete and green in CI against real
Postgres and Redis. The `stable` label is withheld until an independent security review and
production mileage close. The satellites are **experimental**. Read the full
[stability matrix](/reference/stability) and the [security guide](/guides/security) before adopting, and
pin your version.

## How do I test an app built on this?

The package ships testing helpers (`buildTestTenant`, `MockTenantRepository`,
`setRequestTenant`, `withTenant`) plus an in-memory `sqlite-memory` driver for fast unit
tests. See [Testing](/guides/testing).

## Read next

- [Troubleshooting](/reference/gotchas); fixes for the sharp edges.
- [Known limitations](/reference/known-limitations); the deliberate non-goals.
- [Comparison](/reference/comparison); how it stacks up against stancl and NestJS.
