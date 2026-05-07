---
title: Read replicas
description: Route read queries to a pool of PostgreSQL replicas with round-robin, random, or sticky-by-tenant-id strategies. Connections are reused per `(tenantId, hostIndex)`.
---

# Read replicas

Production multi-tenant Postgres deployments usually scale reads
horizontally before they touch a primary upgrade. `ReadReplicaService`
lets a tenant model pick a read replica per query without forcing you
to write connection-routing logic in every controller.

## Configuration

```ts
// config/multitenancy.ts
import { defineConfig } from '@adonisjs-lasagna/saas-tenancy'

export default defineConfig({
  // ...everything else
  tenantReadReplicas: {
    hosts: [
      { host: 'pg-replica-eu-1.internal', name: 'eu-1' },
      { host: 'pg-replica-eu-2.internal', name: 'eu-2' },
      { host: 'pg-replica-eu-3.internal', name: 'eu-3' },
    ],
    strategy: 'sticky',         // optional, defaults to 'round-robin'
    connectionSuffix: '_read',  // optional, defaults to '_read'
  },
})
```

Each `ReadReplicaHost` overrides `host`, `port`, `user`, `password`
on top of the primary tenant connection's pg config. Anything you
don't override (database name, search_path, pool size) is inherited
unchanged. This way a replica you provision with the same role +
schema layout works without restating the credentials.

## Strategies

| Strategy | Behavior | When to use |
|---|---|---|
| `round-robin` (default) | Global in-memory cursor cycles through hosts | Even read distribution; cheapest |
| `random` | `Math.random()` selects a host per call | Workloads where one tenant could otherwise hot-spot a single replica |
| `sticky` | SHA-1 of `tenant.id` modulo pool size | Caching benefits — same tenant always lands on the same replica's page cache |

The cursor for `round-robin` lives in process memory, so it's
balanced *per node*, not globally across a fleet. With many
application instances behind a load balancer the distribution still
averages out across a pool.

## Reading from a replica

```ts
import app from '@adonisjs/core/services/app'
import { ReadReplicaService } from '@adonisjs-lasagna/saas-tenancy/services'

const replicas = await app.container.make(ReadReplicaService)

const conn = await replicas.resolve(tenant)
if (conn) {
  // Use the replica connection for read-heavy queries
  const reports = await conn.from('analytics_reports').select('*')
} else {
  // No replicas configured — fall back to the primary
  const reports = await tenant.related('analyticsReports').query()
}
```

`resolve()` returns `null` when no replicas are configured, letting
you write code that works the same in dev (no replicas) and in prod
(replica pool). The Lucid connection is registered on first use under
a stable name (`${tenantConnectionNamePrefix}${tenantId}${suffix}_${idx}`)
so subsequent calls reuse it — no per-query handshake.

## Where this kicks in automatically

Lasagna does not silently route every read to a replica — that would
introduce subtle replication-lag bugs. Instead, the service is
exposed as a primitive you opt into where it's safe:

- `tenant:doctor replicaLagCheck` uses it to query each replica's
  lag. See [Health checks](/docs/health) and the
  [doctor command](/docs/commands#tenant-doctor).
- The `multi-region replicas` cookbook shows wiring up Lucid model
  helpers that pick a replica for explicit read paths:
  [Multi-region replicas](/docs/cookbook/multi-region-replicas).

For a write path, always use `tenant.getConnection()` (the primary).
Reading your own writes is impossible across asynchronous replication;
sticky routing reduces the window but doesn't eliminate it.

## Replica lag check

The doctor command runs `SELECT EXTRACT(EPOCH FROM
(now() - pg_last_xact_replay_timestamp()))` against every replica and
reports them in the same table as the other tenancy diagnostics:

```bash
node ace tenant:doctor --check=replicaLag
```

Configure thresholds in
[`src/services/doctor/checks/replica_lag_check.ts`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/src/services/doctor/checks/replica_lag_check.ts);
warn at 30s, error at 120s by default.

## Determinism in tests

`resetCursor()` resets the round-robin counter so tests are
reproducible:

```ts
const replicas = await app.container.make(ReadReplicaService)
replicas.resetCursor()

const a = replicas.pickIndex(tenant.id)  // 0
const b = replicas.pickIndex(tenant.id)  // 1
const c = replicas.pickIndex(tenant.id)  // 2 (or wraps)
```

`pickHost(tenantId)` is the convenience accessor that returns the
host config object directly when you want to log the chosen replica.

## Related

- [Multi-region replicas cookbook](/docs/cookbook/multi-region-replicas) —
  end-to-end recipe with Lucid model helpers
- [Health & metrics](/docs/health) — replica state surfaces in
  `tenant:doctor` and `/metrics`
- [Concepts](/docs/concepts) — connection naming and pooling overview
