---
title: Health & metrics
description: Liveness, readiness, and Prometheus endpoints with pluggable checks. Built without prom-client; uses the Lasagna `HealthService` and a string-based exporter.
---

# Health & metrics

Lasagna ships its own health probes and Prometheus exporter so a
freshly configured app can satisfy a Kubernetes deployment manifest
or a Grafana scrape config without pulling another dependency.

## Endpoints

Mount the routes from `start/routes.ts`:

```ts
import { multitenancyRoutes } from '@adonisjs-lasagna/saas-tenancy/health'

multitenancyRoutes() // root paths
multitenancyRoutes({ prefix: '/internal' }) // /internal/livez, etc.
multitenancyRoutes({ metrics: false }) // skip /metrics
```

Four endpoints are exposed by default:

| Path           | Purpose                                                                    | Status code                                      |
| -------------- | -------------------------------------------------------------------------- | ------------------------------------------------ |
| `GET /livez`   | Liveness — process is up. Never touches DB or Redis.                       | Always `200` while the event loop is alive       |
| `GET /readyz`  | Readiness — every registered check passes                                  | `200` when `ok` or `degraded`; `503` when `fail` |
| `GET /healthz` | Same data as `/readyz`, full JSON report                                   | `200` / `503`                                    |
| `GET /metrics` | Prometheus text exposition (snapshot of tenants, circuits, queues, uptime) | `200`                                            |

Each one is opt-in via `multitenancyRoutes({ health: false, metrics: false })` so you can host them under your own auth middleware:

```ts
import router from '@adonisjs/core/services/router'
router
  .group(() => multitenancyRoutes())
  .prefix('/_ops')
  .use([adminAuth])
```

## Built-in checks

The provider registers three default checks during `boot()`:
`backoffice_db` (critical), `redis` (critical) and `circuit_breakers`
(non-critical). Your own providers boot after the package's, so a check
you `addCheck()` under one of those names replaces the default, and
`removeCheck()` opts it out entirely — nothing re-registers behind your
back at probe time. The same registration the provider runs is exported
as `registerDefaultChecks(healthService)`, and the individual checks are
exported too when you want to control criticality, timeouts or ordering
yourself:

```ts
import app from '@adonisjs/core/services/app'
import {
  HealthService,
  backofficeDbCheck,
  redisCheck,
  makeCircuitBreakerCheck,
} from '@adonisjs-lasagna/saas-tenancy/health'
import { CircuitBreakerService } from '@adonisjs-lasagna/saas-tenancy/services'

const health = await app.container.make(HealthService)
const breaker = await app.container.make(CircuitBreakerService)

health.addCheck('backoffice_db', backofficeDbCheck, { critical: true })
health.addCheck('redis', redisCheck, { critical: true })
health.addCheck(
  'circuits',
  makeCircuitBreakerCheck(() => breaker.allMetrics())
)
```

A check registered with `{ critical: true }` pulls the pod on its own: if
it fails, the aggregate status is `fail` and `/readyz` answers 503 even
while every other check passes. Use it for dependencies without which the
pod cannot serve a single request; that's why the defaults mark the
backoffice database and Redis critical. `health.isCritical(name)` reports
how a check was registered, and the per-check entry in the report carries
`critical: true` so the 503 body explains which check pulled the pod.

| Check                         | What it does                                                                 | When it fails                                                       |
| ----------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `backofficeDbCheck`           | `SELECT 1` against the backoffice connection                                 | DB unreachable, credentials wrong                                   |
| `redisCheck`                  | `PING` against the default Redis                                             | Redis down or misconfigured                                         |
| `makeCircuitBreakerCheck(fn)` | Reports `fail` if any tenant circuit is `OPEN`                               | One or more tenant DBs are tripped                                  |
| `billingHealthCheck`          | Pings the Stripe API + asserts webhooks are flowing (when active subs exist) | API unreachable, webhook secret missing, or last processed > 15 min |

When billing is enabled, register `billingHealthCheck` alongside the
others. The check skips quietly when `config.billing` is unset, so
it's safe to register unconditionally:

```ts
import { billingHealthCheck } from '@adonisjs-lasagna/billing'

health.addCheck('billing', billingHealthCheck)
```

Thresholds (`SLOW_API_THRESHOLD_MS = 3000`, stale-warn 5 min, fail
15 min) are documented in
[Billing satellite#health](/docs/satellites/billing#health). The
exposed `SLOW_API_THRESHOLD_MS` constant is importable for tests
that need to drive the degraded branch deterministically.

The Stripe webhook receiver itself is mounted via a separate helper
(it's a route, not a check):

```ts
import { multitenancyBillingRoutes } from '@adonisjs-lasagna/billing'

multitenancyBillingRoutes()
```

## Custom checks

Any function returning `Promise<CheckResult> | CheckResult` works:

```ts
import type { HealthCheckFn } from '@adonisjs-lasagna/saas-tenancy/health'

const customCheck: HealthCheckFn = async () => {
  try {
    await someExternalDependency.ping()
    return { status: 'pass', durationMs: 0 }
  } catch (error: any) {
    return { status: 'fail', durationMs: 0, message: error.message }
  }
}

health.addCheck('custom_dependency', customCheck)
```

`HealthService` enforces a 2-second timeout per check (`Promise.race`)
and never lets a slow check block the readiness response. Failures
and timeouts both surface as `status: 'fail'` with the error message
in `message`.

The aggregate `/readyz` status is:

- `ok` — every check passed (or no checks registered)
- `degraded` — at least one non-critical check failed while the rest
  passed (`200` so Kubernetes keeps routing traffic but the dashboard
  reflects the issue)
- `fail` — any **critical** check failed, or every check failed (`503`,
  traffic is removed)

These semantics are pinned over real HTTP by
`packages/core/tests/integration/health/readyz_http.spec.ts`.

## Prometheus metrics

`/metrics` returns text-exposition format with these series, no
external `prom-client` dependency:

```
multitenancy_tenants_total                      gauge
multitenancy_tenants_by_status{status="..."}    gauge
multitenancy_circuit_state{tenant_id="..."}     gauge   0=CLOSED 1=HALF_OPEN 2=OPEN
multitenancy_circuit_failures_total{...}        counter
multitenancy_circuit_successes_total{...}       counter
multitenancy_queue_jobs{tenant_id,queue,state}  gauge   state ∈ waiting,active,completed,failed,delayed
multitenancy_uptime_seconds                     gauge
```

A typical Prometheus scrape config:

```yaml
- job_name: lasagna
  scrape_interval: 30s
  metrics_path: /metrics
  static_configs:
    - targets: ['app.internal:3333']
```

## Building snapshots programmatically

`collectSnapshot()` and `renderPrometheus()` are exported for cases
where you want to push metrics elsewhere (statsd bridge, scheduled
job, custom dashboard endpoint):

```ts
import { collectSnapshot, renderPrometheus } from '@adonisjs-lasagna/saas-tenancy/health'

const snapshot = await collectSnapshot()
const text = renderPrometheus(snapshot)
await fetch('https://my-collector.internal/ingest', { method: 'POST', body: text })
```

`MetricsSnapshot` is also exported as a type when you want to derive
your own format.

## Kubernetes probe example

```yaml
livenessProbe:
  httpGet: { path: /livez, port: 3333 }
  initialDelaySeconds: 5
  periodSeconds: 10

readinessProbe:
  httpGet: { path: /readyz, port: 3333 }
  initialDelaySeconds: 10
  periodSeconds: 5
  failureThreshold: 3
```

`/livez` is intentionally cheap so the kubelet doesn't kill a pod
because Postgres hiccupped — that's `/readyz`'s job.

## Related

- [Deployment](/docs/deployment) — wiring the endpoints into a Helm chart
- [Doctor command](/docs/commands#tenant-doctor) — deeper diagnostics
  including replica lag, queue stalls, and stalled provisioning
- [Custom-domain HTTPS cookbook](/docs/cookbook/custom-domain-https) — TLS termination concerns when these endpoints are exposed
