---
title: Scheduler
description: A plugin schedule is one periodic tick that fans out over active tenants — declare cron or an interval, name the per-tenant job, and the host worker fires it once per interval across every pod.
---

# Scheduler

A **schedule** lets a plugin run periodic work for every tenant without wiring one
repeatable per tenant. You declare a single tick (a cron expression or a fixed
interval plus the name of a per-tenant job), and on each firing the scheduler fans
out over active tenants, dispatching that job to each one's queue. One declaration
covers 10 tenants or 10,000, and a suspended or deleted tenant drops out of the
fan-out for free through the status filter.

This is the `schedules` seam of [definePlugin](/guides/plugins#schedules). For the
rest of the plugin surface, start there.

<Callout type="tip" title="One tick, N tenants">
A schedule is NOT a per-tenant repeatable. It is a single control tick that
enumerates tenants and dispatches per-tenant jobs. That keeps the queue free of
N×M repeatable keys and their teardown on suspend/delete, at the cost of a global
cadence per schedule (no per-tenant cron in this version).
</Callout>

## Declaring a schedule

```ts
import { definePlugin, schedule, permission } from '@adonisjs-lasagna/saas-tenancy/plugin'

export default definePlugin({
  name: 'search',
  satelliteApi: 1,
  // Declared so the operator consents at install; see Declaring permissions.
  permissions: [permission.scheduler()],
  schedules: () => [
    // Every 5 minutes: reindex each active tenant.
    schedule({ name: 'reindex', job: 'search.ReindexTenant', everyMs: 300_000 }),

    // Nightly at 02:00 UTC, spread over 30s so 10k tenants don't fire at once.
    schedule({
      name: 'digest',
      job: 'app.SendDigest',
      cron: '0 2 * * *',
      jitterMs: 30_000,
      deliveryGuarantee: 'fire-once',
    }),
  ],
})
```

Each `schedule({ ... })` takes:

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Unique schedule slug (identifier-safe). Interpolated into the schedule id and each dispatch's `jobId`. |
| `job` | yes | The per-tenant job name dispatched to every matching tenant's queue. |
| `cron` / `everyMs` | exactly one | A cron expression, or a fixed interval in ms. Setting both or neither fails closed at boot. |
| `timezone` | no | IANA timezone for `cron` evaluation. Defaults to UTC. |
| `statuses` | no | Which tenant statuses to fan out to. Defaults to `['active']`. |
| `jitterMs` | no | Upper bound on a random per-tenant dispatch delay, to spread the fan-out. Defaults to 0. |
| `payload` | no | Static payload merged into every per-tenant dispatch. |
| `deliveryGuarantee` | no | `reconciling` (default) or `fire-once` — informational, see below. |

## The per-tenant job

`job` names a job the tick dispatches to each tenant's own queue, so it runs with
that tenant's context. Extend `TenantJob` so models, cache, and logging resolve to
the tenant:

```ts
import { TenantJob, type TenantJobPayload } from '@adonisjs-lasagna/saas-tenancy/jobs'

export default class ReindexTenant extends TenantJob<TenantJobPayload> {
  static options = { name: 'search.ReindexTenant' }

  protected async perform(): Promise<void> {
    // Tenant-scoped: TenantBaseModel queries hit this tenant's schema.
    await SearchIndex.rebuild()
  }
}
```

## How it fires

The scheduler is built on the native `@adonisjs/queue` scheduler, not a hand-rolled
lock. In the provider's `ready()`, each declared schedule is **armed** as one native
schedule (upserted by a deterministic id, so re-arming on another pod or a redeploy
updates in place rather than duplicating). The host's `queue:work` worker then fires
it: the worker **atomically claims** a due schedule, so the tick is **dispatched
once per interval** across every pod. There is no advisory lock to configure and no
thundering-herd window. The dispatched tick *body* still runs at-least-once (a
worker retry or stall recovery can re-run it), which is why the per-tenant dispatch
carries a best-effort dedup id and why reconciling work is the pattern to prefer.

<Callout type="warning" title="The scheduler needs a running worker">
Schedules fire on the `@adonisjs/queue` worker (`node ace queue:work`), the same
worker that runs `InstallTenant`. If nothing runs that worker, nothing ticks.
Arming also needs `@adonisjs/queue` configured; a declared schedule that cannot be
armed fails the deploy closed rather than silently never running.
</Callout>

## Idempotency and delivery

Each per-tenant dispatch carries a deterministic `jobId` (`<schedule>:<tenant>:<period>`),
so a worker retry of the same tick within the same period tries to re-dispatch the
same ids. That dedup is **best-effort**: the per-tenant queue only retains a
*completed* id for a bounded window (`removeOnComplete`), so for a large fan-out the
early ids evict before the retry runs and most tenants are re-dispatched rather than
deduped. Do not rely on it for correctness. Correctness comes from the schedule's
shape:

- **`reconciling`** (default): the work is idempotent catch-up ("sync whatever is
  behind"). A missed tick (a worker down during the window) self-heals on the next
  tick, which simply picks up the still-pending work. This is the pattern to prefer.
- **`fire-once`**: the work is time-specific ("email the 09:00 summary"). It must
  NOT re-fire at 10:00. The framework does not branch on this flag; it documents
  your intent. For fire-once work you own the compensation (a processed-marker per
  period, or accepting at-most-once with possible loss during an outage) via the
  job's own retry/backoff.

<Callout type="info" title="Availability is bounded by the queue backend">
The scheduler's schedules and the per-tenant queues share the queue backend. A
total backend outage means nothing dispatches AND nothing enqueues. There is no
second path. For schedules that must not miss, run the queue backend in HA and make
the work reconciling so a missed window recovers.
</Callout>

## Failure model

- **Per tenant — fail-open.** A single tenant's dispatch failure inside one tick is
  logged with context and the fan-out continues to the next tenant; one bad tenant
  never starves the rest. The tick reports how many dispatched and how many failed.
- **The tick itself — fail-closed with retry.** If enumerating tenants throws, the
  tick raises a `SchedulerTickException`; the tick job declares `maxRetries`, so the
  worker retries the whole tick and that interval's fan-out still happens.
- **Arming — fail-closed on the worker, fail-open on the web.** A declared schedule
  that cannot be armed aborts the deploy in the worker/console process (where the
  schedule actually runs), so a broken feature surfaces immediately. In the `web`
  process the same failure is logged loudly but does not fail readiness. The worker
  arms the shared schedule anyway, so a transient queue-backend blip must not take
  the API down.

<Callout type="info" title="No automatic un-arm">
Dropping a schedule from a plugin (or uninstalling the plugin) does not delete its
native schedule row; `start()` only upserts. An orphaned schedule keeps firing the
tick, which is a harmless no-op (the tick finds no registered schedule and does
nothing) but leaves a store row and a wasted tick. Remove it with the
`@adonisjs/queue` scheduler commands (`node ace queue:scheduler:remove`) when you
retire a schedule.
</Callout>

## Limits

Cap the total number of registered schedules across all plugins with
`plugins.limits.maxSchedules`. Like the other plugin-surface caps it is enforced
once at boot: exceeding it aborts the deploy. Omit it for unlimited.

```ts
// config/multitenancy.ts
plugins: {
  limits: { maxSchedules: 16 },
}
```

## Read next

- [Building a plugin](/guides/plugins); the rest of the `definePlugin` surface.
- [Background jobs & queues](/guides/jobs); the per-tenant job the tick dispatches.
- [Declaring permissions](/guides/plugins#declaring-permissions); why `scheduler` is
  consent-gated at install.
