---
title: Hooks
description: Run your own code before and after tenant lifecycle operations — provision, destroy, migrate, backup, restore, and clone — programmatically or declaratively from config.
---

# Hooks

Hooks let you run your own code around tenant lifecycle operations without
forking the package. Every provision, destroy, migrate, backup, restore, and
clone fires a `before` and an `after` hook, so you can seed data, notify an
external system, warm a cache, or tear down third-party resources at exactly
the right moment.

<Callout type="tip" title="One registry, two ways to register">
Hooks live in a single <code>HookRegistry</code> singleton. Register them
declaratively in <code>config/multitenancy.ts</code> for the common cases, or
imperatively from a provider when you need container access.
</Callout>

## Events and phases

Each event fires in two phases, `before` and `after`:

| Event | Fires around | Context |
| --- | --- | --- |
| `provision` | tenant schema/database creation | `{ tenant }` |
| `destroy` | tenant teardown | `{ tenant }` |
| `migrate` | per-tenant migrations | `{ tenant, direction: 'up' \| 'down' }` |
| `backup` | tenant backup | `{ tenant, metadata? }` |
| `restore` | tenant restore | `{ tenant, fileName }` |
| `clone` | tenant clone | `{ source, destination, result? }` |

## Failure semantics

The phase decides what a thrown error does:

- A **`before` hook that throws aborts the operation.** Use this to enforce a
  precondition (refuse to provision a tenant whose billing isn't set up, for
  example).
- An **`after` hook that throws is logged and the operation continues.** After
  hooks are side effects; a failed cache warm should never roll back a
  successful provision.

Hooks for the same phase and event run in registration order.

## Declarative hooks (config)

The simplest path. Add a `hooks` object to `config/multitenancy.ts`; the
provider loads it at boot via `loadDeclarative()`:

```ts
// config/multitenancy.ts
export default defineConfig({
  // ...
  hooks: {
    afterProvision: async ({ tenant }) => {
      await SeedService.run(tenant.id)
    },
    beforeDestroy: async ({ tenant }) => {
      await ExternalBilling.cancel(tenant.id)
    },
    afterMigrate: async ({ tenant, direction }) => {
      logger.info({ tenant: tenant.id, direction }, 'tenant migrated')
    },
  },
})
```

The keys are `before`/`after` + the capitalised event name:
`beforeProvision`, `afterProvision`, `beforeDestroy`, `afterDestroy`,
`beforeMigrate`, `afterMigrate`, `beforeBackup`, `afterBackup`,
`beforeRestore`, `afterRestore`, `beforeClone`, `afterClone`.

## Imperative hooks (provider)

When a hook needs the container (to resolve a service) or wants to register
several hooks conditionally, resolve the registry in a provider and use the
chainable `before(event, fn)` / `after(event, fn)` API:

```ts
// providers/app_provider.ts
import { HookRegistry } from '@adonisjs-lasagna/saas-tenancy/services'

export default class AppProvider {
  async boot() {
    const hooks = await this.app.container.make(HookRegistry)

    hooks
      .after('provision', async ({ tenant }) => {
        await this.app.container.make(SearchIndex).create(tenant.id)
      })
      .before('migrate', async ({ tenant, direction }) => {
        if (direction === 'down') await Snapshot.take(tenant.id)
      })
  }
}
```

The context is fully typed per event, so `direction` is available on `migrate`,
`metadata` on `backup`, and `source`/`destination` on `clone`.

## Read next

- [Lifecycle events](/docs/events); fire-and-forget notifications you
  subscribe to, complementary to hooks (which run inline and can abort).
- [Background jobs](/docs/jobs); where provision/destroy hooks actually run.
- [Configuration](/docs/configuration); the full `defineConfig` reference.
