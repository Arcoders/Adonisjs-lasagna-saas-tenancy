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
import { middleware } from '#start/kernel'

// `/metrics` is FAIL-CLOSED: it exposes tenant enumeration + business KPIs, so
// it refuses to mount without a guard. Pass auth for it (the probes stay public):
multitenancyRoutes({ metricsMiddleware: middleware.auth() })
multitenancyRoutes({ prefix: '/internal', metricsMiddleware: middleware.auth() })
multitenancyRoutes({ metrics: false }) // skip /metrics entirely (no guard needed)
```

Four endpoints are exposed by default:

| Path           | Purpose                                                                    | Status code                                      |
| -------------- | -------------------------------------------------------------------------- | ------------------------------------------------ |
| `GET /livez`   | Liveness — process is up. Never touches DB or Redis.                       | Always `200` while the event loop is alive       |
| `GET /readyz`  | Readiness — every registered check passes                                  | `200` when `ok` or `degraded`; `503` when `fail` |
| `GET /healthz` | Same data as `/readyz`, full JSON report                                   | `200` / `503`                                    |
| `GET /metrics` | Prometheus text exposition (snapshot of tenants, circuits, queues, uptime) | `200`                                            |

`/livez` and `/readyz` stay public: Kubernetes probes must reach them without
auth. `/metrics` is different: its snapshot carries per-tenant labels
(circuit-breaker state, queue depths) and tenant counts by status, so it is
**fail-closed**. Calling `multitenancyRoutes()` with `metrics` enabled and no
`metricsMiddleware` throws at startup. Your three choices:

```ts
// 1) Guard it (recommended) — pass any auth/network middleware:
multitenancyRoutes({ metricsMiddleware: middleware.auth() })

// 2) Mount it public on purpose — ONLY behind a trusted network boundary
//    (a private VPC, an authenticating gateway, scrape-only network):
multitenancyRoutes({ metricsMiddleware: false })

// 3) Don't mount it at all:
multitenancyRoutes({ metrics: false })
```

You can also disable the probes (`health: false`) to host them yourself.

## Built-in checks

The provider registers three default checks during `boot()`:
`backoffice_db` (critical), `redis` (critical) and `circuit_breakers`
(non-critical). Your own providers boot after the package's, so a check
you `addCheck()` under one of those names replaces the default, and
`removeCheck()` opts it out entirely; nothing re-registers behind your
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
  makeCircuitBreakerCheck(() => breaker.getAllMetrics())
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
[Billing satellite#health](/guides/satellites/billing#health). The
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

- `ok`: every check passed (or no checks registered)
- `degraded`: at least one non-critical check failed while the rest
  passed (`200` so Kubernetes keeps routing traffic but the dashboard
  reflects the issue)
- `fail`: any **critical** check failed, or every check failed (`503`,
  traffic is removed)

These semantics are pinned over real HTTP by
`packages/core/tests/@guarantees/behavior/integration/behavior_readyz_http.spec.ts`.

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
multitenancy_pool_saturation_ratio{connection,tenant_id}  gauge   numUsed/max, 0..1
multitenancy_pool_pending_acquires{connection,tenant_id}  gauge   connections queued for a slot
multitenancy_quota_ceiling_committed{quota}      gauge   operator-global committed usage
multitenancy_quota_ceiling_outstanding{quota}    gauge   reserved-but-unsettled held against the ceiling
multitenancy_quota_ceiling_utilization_ratio{quota}  gauge   (committed+outstanding)/ceiling
multitenancy_uptime_seconds                     gauge
```

The `multitenancy_quota_ceiling_*` series appear only for quotas that declare an
`plans.operatorCeiling`. They are **operator-level**, labelled by `quota` and
never by `tenant_id`. The per-tenant series would be a cardinality bomb, so
per-tenant budget detail lives in traces and logs, not the scrape. Each is
derived at collect time from the shared operator keys in Redis (bounded by the
number of ceiling-enforced quotas, never a per-tenant scan). Alert on
`multitenancy_quota_ceiling_utilization_ratio` nearing `1` to catch a saturating
denial-of-wallet ceiling before it refuses reservations.

Tenant connection-pool saturation is always exposed on `/metrics`, so you get
observability by default. GATING readiness on it is opt-in: set
`health.tenantPoolsCheck: true` to register the `tenant_pools` check, which fails
(degraded, non-critical) once any pool reaches `health.tenantPoolSaturationThreshold`.
That threshold defaults to `doctor.poolSaturationWarnRatio` (built-in `0.9`), so
the doctor warning, the readiness gate, and the metric all speak with one number;
set it to `1` to fail only when a pool is fully exhausted.

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
because Postgres hiccupped; that's `/readyz`'s job.

## OpenTelemetry tracing

The Prometheus endpoint above covers coarse counters. For request-level tracing (latency,
spans, exceptions) Lasagna ships `TelemetryService`, a thin wrapper over
`@opentelemetry/api`. It is a **static** helper, so you call it directly rather than
resolving it from the container:

```ts
import { TelemetryService } from '@adonisjs-lasagna/saas-tenancy/services'

const report = await TelemetryService.withSpan(
  'report.generate',
  { 'report.kind': 'monthly' },
  async (span) => {
    TelemetryService.setTenant(tenant.id) // tags the active span with tenant.id
    return buildReport(tenant)
  }
)
```

`withSpan(name, attributes, fn)` opens a span, runs `fn` inside its active context, and
always closes it: on success it sets the span status to `OK`; on a throw it records the
exception, sets status `ERROR`, and re-throws so your error handling is unchanged.
`setTenant(tenantId)` adds a `tenant.id` attribute to whatever span is currently active,
which is what ties a trace back to a tenant. `TelemetryService.tracer` exposes the
underlying OpenTelemetry `Tracer` (registered as `adonis-multitenant`) when you need to
start spans by hand.

<Callout type="note" title="You still bring the SDK">
`TelemetryService` only emits spans through the OpenTelemetry API. Where those spans go is
your app's choice: install and configure an OpenTelemetry SDK + exporter (OTLP, Jaeger,
etc.) at boot. Without an SDK registered, the calls are cheap no-ops, so it is safe to
instrument code before you wire up a collector.
</Callout>

The kernel already instruments its cost seam with `addEvent`/`addLink` helpers on
`TelemetryService`. A reservation opens a `quota.reserve` span (with a
`hold_placed` or `refused` event and an `outcome` of `ok` / `over_budget` /
`ceiling`); a `quota.release` span carries the freed remainder; an incremental
`settle` records a `settle` event on the CURRENTLY ACTIVE span rather than a span
per fragment, so a streaming loop does not explode trace volume. `executeExtension`
opens an `extension.execute` span whose `outcome` classifies the terminal state
(`completed` / `timeout` / `aborted` / `rate_limited` / `error`). Every span and
event carries ids, counts, and outcomes only, never prompt or response content.
The span names are a stable contract single-sourced in `services/observability/names.ts`.

## Related

- [Deployment](/guides/deployment); wiring the endpoints into a Helm chart
- [Doctor command](/reference/commands#tenant-doctor); deeper diagnostics
  including replica lag, queue stalls, and stalled provisioning
- [Custom-domain HTTPS cookbook](/guides/cookbook/custom-domain-https); TLS termination concerns when these endpoints are exposed
