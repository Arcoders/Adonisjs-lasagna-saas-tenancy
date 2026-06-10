---
title: Bootstrappers
description: Service-level scoping. Cache, drive, mail, session, broadcasting. Each runs inside the active tenant's namespace automatically.
---

# Bootstrappers

<Callout type="tip" title="One sentence">
A bootstrapper is a per-service hook that enters when tenant context
activates, leaves when it ends, and ensures the service operates on
that tenant's namespace, without you threading <code>tenantId</code>
through every helper.
</Callout>

## How they work

`tenancy.run(tenant, fn)` activates the bootstrapper registry around
`fn`. Each registered bootstrapper sees `enter(ctx)` before `fn`
runs and `leave(ctx)` after, even on `fn` throw. Cleanup is
guaranteed.

```ts
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'
import { cacheFor, tenantDisk, tenantMailer } from '@adonisjs-lasagna/saas-tenancy/services'

await tenancy.run(tenant, async () => {
  await (await tenantMailer()).send(welcomeEmail)       // stamps X-Tenant-Id on the message
  await (await tenantDisk()).put('logo.png', buf)       // key becomes tenants/<id>/logo.png
  await cacheFor(tenant).set('plan', tenant.plan)       // key namespaced under tenant:<id>
})
```

The scoping is explicit: each bootstrapper validates the tenant id at
scope entry and exposes a tenant-aware helper (`cacheFor`,
`tenantDisk`, `tenantMailer`, `tenantSession`, `tenantBroadcast`) that
reads the active tenant from `AsyncLocalStorage`. The underlying
Adonis services (`drive.use()`, `mail`, …) are untouched — code that
calls them directly is not rewritten behind your back.

The HTTP request path activates the registry inside
`TenantGuardMiddleware`. Queue jobs that wrap their handler in
`tenancy.run()` get the same scoping. The `BackupTenant`,
`InstallTenant`, and `UninstallTenant` jobs already do.

## Available bootstrappers

The package ships **five** bootstrappers under
`src/services/bootstrappers/`. Each one wraps a peer Adonis service:

| Bootstrapper | Service | Tenant-aware helper |
|---|---|---|
| [`cacheBootstrapper`](/docs/bootstrappers/cache) | BentoCache | `cacheFor(tenant)` — keys namespaced under `tenant:<id>` |
| [`driveBootstrapper`](/docs/bootstrappers/filesystem) | `@adonisjs/drive` | `tenantDisk(disk?)` — keys prefixed with `tenants/<id>/` |
| [`mailBootstrapper`](/docs/bootstrappers/mail) | `@adonisjs/mail` | `tenantMailer(transport?)` — stamps `X-Tenant-Id` on every message |
| [`sessionBootstrapper`](/docs/bootstrappers/session) | `@adonisjs/session` | `tenantSession(ctx)` / `tenantSessionKey(key)` — keys prefixed with `tenants/<id>/` |
| [`transmitBootstrapper`](/docs/bootstrappers/broadcasting) | `@adonisjs/transmit` | `tenantBroadcast(channel, payload)` / `tenantChannel(name)` — channels prefixed with `tenants/<id>/` |

::: tip Database is not a bootstrapper
Database query routing is handled inside `TenantAdapter` via the
active `IsolationDriver`. It runs before bootstrappers fire, so you
do not need (and cannot register) a `databaseBootstrapper`. See the
[Database routing](/docs/bootstrappers/database) page for the
mechanism.
:::

## Auto-detection

Bootstrappers are auto-registered when the corresponding service binding
is present in the AdonisJS container. The provider probes
`container.hasBinding(...)` for each candidate (`drive.manager`,
`mail.manager`, `session`, `transmit`) and registers the matching
bootstrapper only if the host app loaded the underlying service. The
`cache` bootstrapper is always registered — the package treats it as a
hard requirement.

To opt out of an auto-registered bootstrapper, unregister it after
boot. There is no config flag to suppress one ahead of time:

```ts
// providers/app_provider.ts (or anywhere after the multitenancy
// provider has booted)
import { BootstrapperRegistry } from '@adonisjs-lasagna/saas-tenancy/services'

async ready() {
  const registry = await this.app.container.make(BootstrapperRegistry)
  registry.unregister('drive')  // skip even though @adonisjs/drive is installed
}
```

## Order matters

The registry enters in **registration order** and leaves in reverse,
exactly like a stack. The provider registers the built-ins in this
order:

1. `cache`
2. `drive`
3. `mail`
4. `session`
5. `transmit`

A custom bootstrapper you register afterwards enters last and leaves
first. To run before the built-ins, register yours before the
multitenancy provider boots (or unregister and re-register in your
preferred order).

## Writing a custom bootstrapper

```ts
import {
  BootstrapperRegistry,
  type TenantBootstrapper,
  type BootstrapperContext,
} from '@adonisjs-lasagna/saas-tenancy/services'

export class FeatureFlagsBootstrapper implements TenantBootstrapper {
  readonly name = 'feature-flags'

  async enter(ctx: BootstrapperContext) {
    // Setup work for ctx.tenant
  }

  async leave(ctx: BootstrapperContext) {
    // Tear down whatever enter() set up
  }
}

// Register in your provider
const registry = await this.app.container.make(BootstrapperRegistry)
registry.register(new FeatureFlagsBootstrapper())
```

Lifecycle invariants:

- `leave` runs even if `enter` or `fn` throw.
- A failure in one `enter` aborts the rest and unwinds prior
  successful enters in reverse order.
- `runScoped(ctx, fn)` is the public API for the unwind contract.
  `tenancy.run()` builds on it.

## Read next

- Pick a bootstrapper from the table above.
- [Testing](/docs/testing). How to swap bootstrappers for hermetic
  fakes.
