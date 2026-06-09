---
title: Multi-region replicas
description: Read-replica routing via ReadReplicaService — round-robin, random, sticky — plus the doctor's replica_lag check.
---

# Multi-region replicas

Lasagna ships read-replica routing as a service (`ReadReplicaService`)
that hands you a Lucid connection pointed at the chosen replica.
Three strategies, one contract.

## Why route at the package level

In a multi-tenant app, *all* read traffic for a single tenant tends
to flow to the same routes. Sending those reads to a single replica
maximises cache hit rates on that replica. Sending them round-robin
maximises throughput when tenants are large. Pick per workload.

## Configuration

The replica list lives at `multitenancy.tenantReadReplicas` in
`config/multitenancy.ts`. The shape is `{ strategy, hosts,
connectionSuffix? }` — no `enabled` flag (presence implies enabled),
no per-tenant pinning callback (apps that need pinning route through
their own service in front of `pickIndex()`).

```ts
// config/multitenancy.ts
export default defineConfig({
  tenantReadReplicas: {
    strategy: 'sticky', // 'round-robin' | 'random' | 'sticky'
    hosts: [
      { name: 'replica-eu-1', host: 'pg-replica-eu-1.example.com', port: 5432 },
      { name: 'replica-eu-2', host: 'pg-replica-eu-2.example.com', port: 5432 },
      { name: 'replica-us-1', host: 'pg-replica-us-1.example.com', port: 5432 },
    ],
    connectionSuffix: '_read', // optional; default '_read'
  },
})
```

Each `host` may also override `user` / `password` if the replica
runs under different credentials than the primary; otherwise the
service inherits the primary tenant connection's pg config (host,
user, password, ssl, etc.).

## Strategies

| Strategy | Behaviour | Best for |
|---|---|---|
| `round-robin` | Cycle replicas evenly via an in-memory cursor (per process). | Even workload distribution; many small tenants. |
| `random` | Pick a random replica per call. | Simple, stateless distribution. |
| `sticky` | Hash `tenant.id` to a replica index; same tenant always reads from the same one. | Cache locality; large tenants. |

## Reading from a replica

There is no `Post.query().useReadReplica()` or
`middleware.preferReadReplica()` shortcut today. Opt in by resolving
a connection from `ReadReplicaService` and querying through it
directly:

```ts
import { ReadReplicaService } from '@adonisjs-lasagna/saas-tenancy/services'

const replicas = await app.container.make(ReadReplicaService)

router.get('/api/feed', async ({ request }) => {
  const tenant = await request.tenant()
  const conn = await replicas.resolve(tenant)
  if (!conn) {
    // No replicas configured — fall back to the primary connection
    // returned by the active isolation driver.
    return Post.query().where('published', true)
  }
  return conn.query().from('posts').where('published', true)
})
```

`resolve()` returns `null` when `tenantReadReplicas` is unset, so
your handler can fall back to the primary cleanly.

## Lag awareness

`tenant:doctor --check=replica_lag` connects to each replica and
checks `pg_is_in_recovery()` + `pg_last_xact_replay_timestamp()`.
Issues are emitted at four severities:

- `replica_not_in_recovery` (error) — the host is a primary, not a
  replica. Misconfiguration.
- `replica_lag_high` (warn) — lag > `replicaLagWarnSeconds`
  (default 30s).
- `replica_lag_critical` (error) — lag > `replicaLagErrorSeconds`
  (default 120s).
- `replica_unreachable` (error) — pg connection refused / timed
  out. The pg error code is included in the message; the raw error
  text is dropped to avoid leaking DSNs / passwords into log
  shippers.

## Failover

There is **no automatic failover**. If a replica is unreachable,
`resolve()` still returns a connection — but `conn.rawQuery()` will
throw `ECONNREFUSED` (or similar). Apps that need fallback must
catch and retry against the primary themselves:

```ts
try {
  return await conn.query().from('posts').where(/* … */)
} catch (err) {
  if (looksLikeReplicaOutage(err)) {
    return await Post.query().where(/* … */) // primary
  }
  throw err
}
```

For high-availability, place a Pgbouncer or Patroni in front of the
primary so replica outages never cascade.

## Multi-region writes

Lasagna does not orchestrate multi-region writes. If your app needs
them, run a logical-replication setup (Citus, Patroni, or a managed
PG) and let Lasagna route reads. Writes always go to the primary
configured on the template connection.

## Operational checklist

- [ ] `tenant:doctor --check=replica_lag` in CI / monitoring.
- [ ] Prometheus alert on `multitenancy_replica_lag_seconds > 30`.
- [ ] Test a failover quarterly; promote a replica, verify the app
      keeps serving (with reduced throughput) until the replica
      list is updated.
- [ ] Document each replica's region and capacity in the same file
      as the config.


## Read next

- [Read replicas](/docs/read-replicas); the replica routing this builds on.
- [Scaling limits](/docs/scaling-limits); when to reach for multi-region.
- [Cookbook](/docs/cookbook/); more recipes.
