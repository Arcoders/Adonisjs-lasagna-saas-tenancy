---
title: Lifecycle events
description: 13 typed events fire across the tenant lifecycle. Subscribe with `emitter.on()` and react to provisioning, status changes, backups, clones, quota breaches, and maintenance toggles.
---

# Lifecycle events

Lasagna emits a typed event at every meaningful tenant state
transition. Each event is a class extending the AdonisJS `BaseEvent`,
so you subscribe with the standard `emitter.on(EventClass, listener)`
API and get full payload typing for free.

## When each event fires

| Event | Payload | Dispatched by |
|---|---|---|
| `TenantCreated` | `tenant` | `tenant:create` command, `POST /admin/.../tenants` |
| `TenantProvisioned` | `tenant` | `InstallTenant` job (after schema/database is ready) |
| `TenantActivated` | `tenant` | `tenant:activate` command, `POST .../activate` |
| `TenantSuspended` | `tenant` | `tenant:suspend` command, `POST .../suspend` |
| `TenantUpdated` | `tenant`, `changes` | Available for host code; not auto-dispatched |
| `TenantMigrated` | `tenant`, `direction: 'up' \| 'down'` | `tenant:migrate` and `tenant:migrate:rollback` |
| `TenantBackedUp` | `tenant`, `metadata: BackupMetadata` | `BackupTenant` job |
| `TenantRestored` | `tenant`, `fileName` | `RestoreTenant` job |
| `TenantCloned` | `source`, `destination`, `result: CloneResult` | `CloneTenant` job |
| `TenantQuotaExceeded` | `tenant`, `quota`, `limit`, `current`, `attempted` | `QuotaService.consume()` when an atomic check rejects the increment |
| `TenantEnteredMaintenance` | `tenant`, `message: string \| null` | `tenant:maintenance` command, `POST .../maintenance` |
| `TenantExitedMaintenance` | `tenant` | `tenant:maintenance --off`, `DELETE .../maintenance` |
| `TenantDeleted` | `tenant` | `tenant:destroy` command, `UninstallTenant` job, `DELETE .../tenants/:id` |

::: tip TenantUpdated
The class is exported and ready to dispatch from host code (e.g. an
admin controller mutating tenant metadata), but Lasagna does not emit
it on its own. If you maintain a typed audit trail, dispatch it from
the same writer that mutates the row.
:::

## Subscribing

Register listeners during boot — usually inside a service provider's
`boot()` hook so they're attached before any tenant request hits the
container:

```ts
import emitter from '@adonisjs/core/services/emitter'
import {
  TenantProvisioned,
  TenantQuotaExceeded,
} from '@adonisjs-lasagna/saas-tenancy/events'

export default class AppProvider {
  async boot() {
    emitter.on(TenantProvisioned, async (event) => {
      // event.tenant is fully typed (TenantModelContract)
      await sendWelcomeEmail(event.tenant)
    })

    emitter.on(TenantQuotaExceeded, async (event) => {
      // payload arrived in the constructor order from src/events/
      logger.warn(
        { tenantId: event.tenant.id, quota: event.quota, attempted: event.attempted },
        'Quota threshold breached'
      )
    })
  }
}
```

## Dispatching from your own code

Every event class exposes the static `dispatch(...args)` helper. The
arguments mirror the constructor exactly, so TypeScript catches
payload mismatches at compile time:

```ts
import { TenantUpdated } from '@adonisjs-lasagna/saas-tenancy/events'

await tenant.merge({ name: newName }).save()
await TenantUpdated.dispatch(tenant, {
  name: { from: previousName, to: newName },
})
```

## Async semantics

`emitter.emit()` runs every listener in **parallel**. If a listener
throws, the rejection propagates to the awaited `emit()` call but
sibling listeners still run. If you need ordering or want one bad
listener to block the others, dispatch through a queue job instead of
listening inline.

For batch use cases — long-running mailers, webhook fan-out, large
DB writes — push the work onto a tenant queue from inside the
listener so the dispatch path stays cheap:

```ts
emitter.on(TenantBackedUp, async (event) => {
  await new TenantQueueService().dispatch(event.tenant.id, 'NotifyBackupReady', {
    file: event.metadata.file,
    size: event.metadata.size,
  })
})
```

## Testing

Use `emitter.fake([...EventClasses])` to capture dispatches in tests
without invoking real listeners. The returned buffer exposes
`assertEmitted` / `assertEmittedCount` / `assertNotEmitted`:

```ts
import emitter from '@adonisjs/core/services/emitter'
import { TenantSuspended } from '@adonisjs-lasagna/saas-tenancy/events'

test('suspending a tenant emits TenantSuspended', async ({ client }) => {
  const buffer = emitter.fake([TenantSuspended])
  await client.post(`/admin/multitenancy/tenants/${tenant.id}/suspend`)
  buffer.assertEmittedCount(TenantSuspended, 1)
  emitter.restore()
})
```

The integration suite covers every event in
[`tests/integration/events/lifecycle_dispatch.spec.ts`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/tests/integration/events/lifecycle_dispatch.spec.ts).

## Related

- [Jobs](/docs/jobs) — most events are dispatched from inside a job
- [Quotas](/docs/satellites/quotas) — source of `TenantQuotaExceeded`
- [Contextual logging](/docs/contextual-logging) — listener log lines
  inherit the active `tenantId`
