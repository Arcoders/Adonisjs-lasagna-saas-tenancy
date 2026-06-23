---
title: Per-tenant worker concurrency
description: Run a dedicated BullMQ worker per tenant with its own concurrency ceiling so one noisy tenant's job burst cannot starve the others, using buildTenantWorkerOptions and the TenantJob base.
---

# Per-tenant worker concurrency

The package dispatches every tenant's jobs to a per-tenant BullMQ queue
(`config.queue.tenantQueuePrefix + tenantId`). It is **dispatch-only** — it never
spawns a worker. By default your single `node ace queue:work` process drains all
those queues with one shared concurrency budget, so a tenant that floods its
queue can monopolise the workers and starve everyone else.

To isolate that, run a dedicated worker per tenant, each with its own concurrency
cap. `buildTenantWorkerOptions()` assembles the per-tenant `WorkerOptions` from
`config.queue`; you own the `Worker` lifecycle.

::: tip Weighted fair-share is deferred
This recipe gives each tenant a fixed cap. True weighted fair-share (premium
tenants get proportionally more workers, auto-tuned from live queue depth) is a
planned, demand-gated satellite, not a core feature. For now, set per-tenant caps
manually as shown below.
:::

## Jobs: extend `TenantJob` for automatic context

Make tenant jobs extend [`TenantJob`](/docs/jobs) so they restore the tenant
context automatically — no manual `tenancy.run()` wrapping:

```ts
// app/jobs/generate_invoice.ts
import { TenantJob, type TenantJobPayload } from '@adonisjs-lasagna/saas-tenancy'

interface GenerateInvoicePayload extends TenantJobPayload {
  invoiceId: string
}

export default class GenerateInvoice extends TenantJob<GenerateInvoicePayload> {
  static options = { name: 'app.GenerateInvoice' }

  protected async perform(): Promise<void> {
    // Inside perform(), models, cache, drive and logging all resolve to the
    // tenant in this.payload.tenantId — set when the job was dispatched.
    await Invoice.findOrFail(this.payload.invoiceId)
  }
}
```

## The per-tenant worker entrypoint

```ts
// app/workers/tenant_worker.ts
import { Worker } from 'bullmq'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import { buildTenantWorkerOptions } from '@adonisjs-lasagna/saas-tenancy/helpers'
import { TenantQueueService } from '@adonisjs-lasagna/saas-tenancy/services'

const tenantId = process.argv[2]
if (!tenantId) {
  console.error('usage: node ace run:tenant-worker <tenantId>')
  process.exit(1)
}

await app.init()
await app.boot()

const queues = await app.container.make(TenantQueueService)
const queueName = queues.getQueueName(tenantId)
// Give this tenant up to 3 jobs in parallel, regardless of other tenants.
const opts = buildTenantWorkerOptions(tenantId, 3)

const { Locator } = await import('@adonisjs/queue')

const worker = new Worker(
  queueName,
  async (job) => {
    const JobClass = Locator.get(job.name)
    if (!JobClass) throw new Error(`unregistered job ${job.name}`)
    const instance = new JobClass()
    // `payload` is a getter — hydrate via $hydrate, never assign it directly.
    instance.$hydrate(job.data, {
      jobId: job.id ?? job.name,
      name: job.name,
      attempt: job.attemptsMade + 1,
      queue: queueName,
      priority: job.opts.priority ?? 0,
      acquiredAt: new Date(),
      stalledCount: 0,
    })
    return instance.execute()
  },
  opts
)

worker.on('failed', (job, err) =>
  logger.error({ tenantId, job: job?.name, err: err.message }, 'tenant job failed')
)
process.on('SIGTERM', async () => {
  await worker.close()
  process.exit(0)
})
```

Wrap it in an ace command (`run:tenant-worker`) and let your orchestration layer
run one process per active tenant — for example a Docker Compose / Kubernetes
deployment per tenant tier, assigning a higher concurrency to premium tenants:

```ts
const concurrency = tenant.plan === 'enterprise' ? 8 : tenant.plan === 'pro' ? 3 : 1
const opts = buildTenantWorkerOptions(tenant.id, concurrency)
```

Multiple workers on the same tenant queue is also valid — BullMQ distributes jobs
across them, so total parallelism is the sum of their concurrencies.

## Monitoring

Poll per-tenant queue depth to decide when to scale a tenant's worker pool:

```ts
const queues = await app.container.make(TenantQueueService)
const stats = await queues.statsForTenants(['acme', 'globex'])
for (const s of stats) {
  if (s.waiting > 100) logger.warn({ tenantId: s.tenantId }, 'queue backing up')
}
```

## Coordinating with tenant lifecycle

When a tenant is destroyed its queue is removed by the uninstall job; shut down
that tenant's worker from your control plane (or on the `TenantDeleted` event) so
it does not poll a queue that no longer exists.

## Related

- [Background jobs](/docs/jobs) — dispatch, the queue lifecycle, and `TenantJob`.
- [Scaling limits](/docs/scaling-limits) — connection budgets and the soft cap.
