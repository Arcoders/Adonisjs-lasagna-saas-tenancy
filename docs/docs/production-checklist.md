---
title: Production checklist
description: One operator-facing page to deploy and run Lasagna safely. Compatibility matrix, a pre-flight checklist, driver choice, known failure modes, and a minimal runbook.
---

# Production checklist & runbook

The single page an operator can deploy and run from. It consolidates the deep
guides into a compatibility matrix, a pre-flight checklist, a driver-choice
summary, the known failure modes with mitigations, and a minimal runbook. Each
item links to the page that explains it in full.

For the step-by-step install and the Docker / Kubernetes artifacts, follow
[Installation](/docs/installation) and [Deployment](/docs/deployment). For what
the package guarantees versus what you own, read the [Security guide](/security).
The labels here reflect the [stability matrix](/docs/stability): the isolation
core is a release candidate, the satellites are experimental.

## Compatibility matrix

| Component                   | Version              | Required                                          |
| --------------------------- | -------------------- | ------------------------------------------------- |
| Node.js                     | `>=24`               | Yes                                               |
| AdonisJS (`@adonisjs/core`) | `^7`                 | Yes                                               |
| `@adonisjs/lucid`           | `^22`                | Yes                                               |
| `@adonisjs/queue`           | `^0.6`               | Yes (provisioning jobs)                           |
| `@adonisjs/redis`           | `^10`                | Yes (cache, counters, breaker state)              |
| PostgreSQL (server)         | 14+ (16 recommended) | Yes                                               |
| Redis (server)              | 6+ (7 recommended)   | Yes                                               |
| `@adonisjs/drive`           | `^3`                 | Optional (filesystem bootstrapper, local backups) |
| `@adonisjs/mail`            | `^10`                | Optional (mail bootstrapper)                      |
| `@adonisjs/session`         | `^7`                 | Optional (session bootstrapper)                   |
| `better-sqlite3`            | `^11`                | Optional (`sqlite-memory` test driver only)       |
| `stripe`                    | `^18`                | Optional (`@adonisjs-lasagna/billing`)            |
| `jose`                      | latest               | Optional (`@adonisjs-lasagna/sso`)                |
| `@aws-sdk/client-s3`        | latest               | Optional (`@adonisjs-lasagna/backup` S3 archival) |

The package targets PostgreSQL only. MySQL and MariaDB are not supported (schemas
are a Postgres-native concept).

## Pre-flight checklist

Tick each before you take production traffic. The right-hand link is where the
setting and its trade-off are explained.

- [ ] **Egress controls.** Route app egress through a proxy or security group
      that denies private, loopback, link-local, and cloud-metadata ranges. The SSRF
      guard validates URLs but does not pin the resolved IP, so network egress closes
      the residual DNS-rebinding window for SSO and webhook fetches. See
      [Troubleshooting](/docs/gotchas) and [Security](/security).
- [ ] **Connection budget.** Keep `maxTenantConnections × poolMax` (plus central,
      backoffice, and replica pools) under PostgreSQL `max_connections`. Decide on
      `enforceConnectionCap` (default `false` favours availability; `true` is a firm
      503 ceiling). Front Postgres with **PgBouncer** at scale. See
      [Scaling limits](/docs/scaling-limits).
- [ ] **Grace window.** Set `evictionGracePeriodMs` at or above your p99 request
      latency so an in-flight request is never severed. See
      [Scaling limits](/docs/scaling-limits).
- [ ] **Row-Level Security (only for `rowscope-pg`).** Run
      `node ace configure @adonisjs-lasagna/saas-tenancy --with=rls`, edit the
      migration to list your real `rowScopeTables` and column, and migrate under a DB
      role **without** `SUPERUSER` / `BYPASSRLS`. See
      [rowscope-pg](/docs/data-isolation/rowscope-pg).
- [ ] **Admin API auth.** Pass `middleware` to `multitenancyAdminRoutes(...)` so
      the destructive routes are guarded; it is fail-closed and throws at boot if you
      omit it. Use `middleware: false` only behind a trusted network boundary. See
      [Admin REST API](/docs/admin-rest-api).
- [ ] **Metrics exposure.** `/metrics` always carries per-tenant series and is
      fail-closed: `multitenancyRoutes` throws at boot without a
      `metricsMiddleware` (pass `metricsMiddleware: false` only behind a trusted
      network boundary). Expose only the `/livez`, `/readyz`, `/healthz` probes
      publicly, and remember the Prometheus scrape job needs the credential. See
      [Health & metrics](/docs/health).
- [ ] **Webhooks.** Keep `WEBHOOKS_ALLOW_LOOPBACK_TARGETS` off in production.
- [ ] **Stripe (if billing).** Use real keys and keep `STRIPE_ALLOW_LIVE_IN_DEV`
      off outside development.
- [ ] **Read replicas.** There is no automatic failover. Use the `sticky`
      strategy and route read-after-write paths to the primary with the
      retry-on-primary pattern. See [Read replicas](/docs/read-replicas).
- [ ] **Queue worker.** Run at least one process with `node ace queue:work`
      alongside the HTTP pods. Tenant provisioning is dispatched on BullMQ; without
      a worker every new tenant sits in `provisioning` forever. See
      [Deployment](/docs/deployment).
- [ ] **Readiness semantics.** The default `backoffice_db` and `redis` checks
      are critical: either failing pulls the pod (503). Checks you register are
      non-critical unless you pass `{ critical: true }`, so a failing custom check
      alone keeps the pod serving with a `degraded` 200. See
      [Health & metrics](/docs/health).
- [ ] **Backups.** Enable retention and S3 mirroring, and **test a restore** (not
      just a backup) at least quarterly. See the backup section in
      [Deployment](/docs/deployment).
- [ ] **Transport.** Terminate TLS at the load balancer or Ingress, serve HSTS,
      and add the security-headers middleware from [Deployment](/docs/deployment).
- [ ] **Shared cache across pods.** Point the tenant-resolution cache at a shared
      Redis store so one pod's invalidation reaches the others. See
      [Deployment](/docs/deployment).
- [ ] **Secrets.** Keep DB and app secrets out of the repo (Vault, AWS / GCP
      secret managers, sealed-secrets). Node stays within `>=24`.

## Choosing a driver

| Driver                | Isolation               | Best for                       | Main ceiling                                               |
| --------------------- | ----------------------- | ------------------------------ | ---------------------------------------------------------- |
| `schema-pg` (default) | High (per-schema)       | Tens to a few thousand tenants | Catalog bloat, O(N) migrate / backup, connection fan-out   |
| `database-pg`         | Highest (per-database)  | Fewer, higher-value tenants    | Heavier per-tenant overhead, `CREATEDB` privilege          |
| `rowscope-pg`         | Lower (query predicate) | Very many small tenants        | Isolation depends on `tenancy.run()` plus the RLS backstop |

Full trade-offs and the per-driver benchmark shape are in
[Data isolation](/docs/data-isolation/), [Scaling limits](/docs/scaling-limits),
and [Performance](/docs/performance).

## Failure modes and limitations

Every entry is a deliberate behaviour, not a bug. The reference column points at
the detail and the mitigation.

| Mode                                    | Behaviour                                                                         | Mitigation                                                      | Reference                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Postgres down for a resolved tenant     | Typed 503 (`DependencyUnavailableException`), never served central; auto-recovers | Retry; alert on the 5xx rate                                    | [Troubleshooting](/docs/gotchas), [Resilience](/docs/resilience)       |
| Redis down                              | Rate limit fails closed (503 by default); a `fail-open` quota skips enforcement   | Pick the policy per dependency; alert on `DependencyDegraded`   | [Configuration](/docs/configuration), [Troubleshooting](/docs/gotchas) |
| Connection cap saturated                | Exceeds the cap (default) or refuses with 503 (`enforceConnectionCap: true`)      | Raise `maxTenantConnections`, add PgBouncer                     | [Scaling limits](/docs/scaling-limits)                                 |
| Read replica lagging or down            | Still selected; no lag check, no failover                                         | `sticky` + retry-on-primary                                     | [Read replicas](/docs/read-replicas)                                   |
| Provisioning to active race             | Transient 503 (`TenantNotReadyException`) until the schema is ready               | Wait for `TenantActivated` before redirecting in                | [Troubleshooting](/docs/gotchas)                                       |
| SSRF DNS rebinding (TOCTOU)             | URL validated, resolved IP not pinned                                             | Network egress controls                                         | [Troubleshooting](/docs/gotchas), [Security](/security)                |
| Top-level `orWhere` under `rowscope-pg` | Can widen a query past the tenant predicate                                       | Nested `where` group + the RLS backstop                         | [rowscope-pg](/docs/data-isolation/rowscope-pg)                        |
| Disk or Postgres resource exhaustion    | Provisioning and writes fail; the cap does not bound disk / CPU / IOPS            | Monitor those separately; re-run provisioning after remediation | [Troubleshooting](/docs/gotchas)                                       |
| Multi-pod cache drift                   | Per-process cache serves stale tenant data                                        | Shared Redis cache store                                        | [Deployment](/docs/deployment)                                         |

## Runbook

### Suspected cross-tenant leak

1. **Confirm the driver and its contract.** For `rowscope-pg`, verify the RLS
   migration ran under a non-superuser role and that tenant work runs inside
   `withTenantRls(...)` / `tenancy.run(...)`. A top-level `orWhere` is the usual
   app-side cause; see [Troubleshooting](/docs/gotchas).
2. **Reproduce under load.** Run the isolation gate against the suspect driver:
   `BENCH_DRIVER=<driver> npm run bench:isolation` (it asserts zero cross-tenant
   rows on the real request path). `BENCH_ISO_SELFTEST=1 npm run bench:isolation`
   must FAIL, which proves the detector works.
3. **Read the trail.** Enable the `audit` satellite and query the admin REST API
   date-range endpoint to scope which tenants and rows were touched.
4. **Contain.** Suspend the affected tenants (status change) while you patch, and
   rotate any data exposed.

### Reading the metrics

Scrape `/metrics` (Prometheus). The series that predict incidents:

- `multitenancy_circuit_state{state="OPEN"}` — a tenant DB is failing fast; alert
  on any sustained OPEN.
- `multitenancy_provisioning_failures_total` — provisioning is erroring; pair
  with disk and Postgres resource dashboards.
- Replica lag exceeding your `doctor.replicaLagWarnSeconds` threshold.

`node ace tenant:doctor --json` is the fastest deep look, but know that it
runs a different, wider check set than `/readyz` (schema drift, migration
state, stuck queues, replica lag, connection pool, long-running queries).
`/readyz` only aggregates the registered HealthService checks, with
`backoffice_db` and `redis` critical by default. See
[Health & metrics](/docs/health).

### Scaling the connection cap

The signal is a throttled warning that the LRU exceeded the cap rather than
severing a request. Respond by either:

- raising `maxTenantConnections` and confirming `max_connections` still covers
  `maxTenantConnections × poolMax` plus headroom, or
- fronting Postgres with **PgBouncer** (transaction pooling) and, if you need a
  firm server-connection ceiling, setting `enforceConnectionCap: true` and sizing
  `max_connections` for the cap rather than the tenant count.

See [Scaling limits](/docs/scaling-limits).

### Dependency outage response

- **Postgres down:** resolved-tenant requests return 503 and recover on their own
  when Postgres returns; no manual step beyond restoring the database. If a tenant
  stays OPEN after recovery, `tenant:doctor --fix` force-closes its breaker.
- **Redis down:** the rate limiter and any `fail-closed` quota return 503; a
  `fail-open` quota stops enforcing silently, so alert on `DependencyDegraded`.
  Restore Redis to clear it.
- **Replica down or lagging:** there is no failover, so route reads to the primary
  (the retry-on-primary pattern) until the replica catches up. See
  [Read replicas](/docs/read-replicas).

## Read next

- [Deployment](/docs/deployment); the Docker and Kubernetes artifacts.
- [Security](/security); the hardening guarantees behind this checklist.
- [Resilience](/docs/resilience); how the package degrades under dependency outages.
