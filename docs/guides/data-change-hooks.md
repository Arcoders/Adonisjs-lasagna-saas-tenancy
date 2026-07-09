---
title: Data-change hooks
description: The TracksDataChanges mixin emits an after-commit event for each tenant-model write, and definePlugin({ onDataChange }) subscribes to it — so search, analytics, and realtime plugins react to writes without the model importing them.
---

# Data-change hooks

A data-change hook lets a plugin **react to tenant-model writes** — reindex a search
document, bump an analytics counter, broadcast a realtime update — without the model
ever importing the plugin. You opt a model in with the `TracksDataChanges` mixin; it
emits a `TenantDataChanged` event after each committed write, and a plugin subscribes
with `definePlugin({ onDataChange })`.

This is the `onDataChange` seam of [definePlugin](/guides/plugins). For the rest of
the plugin surface, start there.

<Callout type="tip" title="Isolation by construction">
The event names WHAT changed — model, table, primary key, and for an update the
changed COLUMN NAMES — never the column values. A subscriber that needs the new
values re-enters `tenancy.run(tenantId)` and re-reads the row, so tenant isolation
holds by construction. The payload is safe to log or queue for a surrogate-key model;
a model with a natural primary key (an email or slug) does put that key value in
`keys`.
</Callout>

## Emitting: opt a model in

The mixin is OFF by default — `TenantBaseModel` never emits. Wrap a model in
`TracksDataChanges` to turn it on:

```ts
import { TenantBaseModel } from '@adonisjs-lasagna/saas-tenancy'
import { TracksDataChanges } from '@adonisjs-lasagna/saas-tenancy/mixins'

export default class Order extends TracksDataChanges(TenantBaseModel) {
  // ... columns
}
```

Now every committed `create` / `update` / `delete` on an `Order` **instance** emits a
`TenantDataChanged`. The guarantees:

- **After-commit.** The emit is deferred to the transaction's `commit`, so a write
  that ROLLS BACK emits nothing. An autocommit write emits inline (it already
  committed). One edge: a nested transaction (a savepoint) that commits before its
  outer transaction rolls back can still emit — the rollback guarantee is absolute
  only for a top-level transaction.
- **Attributed, or skipped.** The change is tagged with `tenancy.currentId()`. With
  no active tenant scope it is SKIPPED, never emitted mis-attributed.

<Callout type="warning" title="Instance writes only">
The mixin wires Lucid's per-instance hooks, so it fires for `model.save()` /
`Model.create()` / `model.delete()`. A query-builder BULK mutation —
`Order.query().where(...).update({...})` or `.delete()` — bypasses instance hooks
entirely and emits NOTHING. If you rely on the hook for cache/search invalidation,
mirror your bulk writes yourself. Filtering by `models` uses the class NAME, which a
minified build mangles; filter on the change's `table` in a bundled deployment.
</Callout>

## Subscribing: onDataChange

```ts
import { definePlugin } from '@adonisjs-lasagna/saas-tenancy/plugin'
import { tenancy, resolveTenantRepository } from '@adonisjs-lasagna/saas-tenancy'

export default definePlugin({
  name: 'search',
  satelliteApi: 1,
  onDataChange: () => [
    {
      models: ['Order', 'Product'], // omit to receive every model
      operations: ['create', 'update', 'delete'], // omit for every operation
      handle: async (change) => {
        // Need the row's values? Re-enter the tenant and re-read — never trust the
        // payload to carry them. Resolve the real tenant model through the
        // repository (a hand-built `{ id }` skips it and breaks any bootstrapper
        // that reads tenant.metadata/name in enter()).
        const repo = await resolveTenantRepository()
        const tenant = await repo.findById(change.tenantId)
        if (!tenant) return
        await tenancy.run(tenant, async () => {
          const row = await Order.find(change.keys.id)
          if (row) await SearchIndex.upsert(row)
        })
      },
    },
  ],
})
```

Filters are optional and AND-combined: omit `models`/`operations` to receive
everything. Subscriptions are wired in the plugin's `ready()`.

<Callout type="warning" title="Fail-open, never silent">
A subscriber runs decoupled from the write (after-commit), so a slow or failing
handler NEVER blocks or rolls back the tenant's write. A throwing handler is caught,
logged, and counted on the per-tenant `data_change_subscriber_errors` metric — it is
never silently swallowed, and one plugin's failure never affects another's handler.
</Callout>

## The payload

```ts
interface TenantDataChangePayload {
  tenantId: string
  model: string        // the Lucid model class name, e.g. 'Order'
  table: string        // its database table
  operation: 'create' | 'update' | 'delete'
  keys: Record<string, unknown>   // the row's primary key
  columns?: readonly string[]     // update only: the changed column NAMES
}
```

## Subscribing without the facade

`onDataChange` is sugar. You can subscribe to the raw event through the standard
emitter — the same `TenantDataChanged` class, exported from `/events` and `/mixins`:

```ts
import emitter from '@adonisjs/core/services/emitter'
import { TenantDataChanged } from '@adonisjs-lasagna/saas-tenancy/mixins'

emitter.on(TenantDataChanged, (e) => console.log(e.change.model, e.change.operation))
```

Doing it by hand means you own the filtering and the fail-open try/catch that the
facade gives you.

## Read next

- [Building a plugin](/guides/plugins); the rest of the `definePlugin` surface.
- [Events](/reference/events); every event the package dispatches.
- [Scheduler](/guides/scheduler); the other Lote-B/C worker seam.
