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
import { tenancy } from '@adonisjs-lasagna/saas-tenancy/services'

await tenancy.run(tenant, async () => {
  await emails.send(welcomeEmail)        // mail bootstrapper picked the right SMTP
  await drive.use().put('logo.png', buf) // drive bootstrapper prefixed the key
  await cache.set('plan', tenant.plan)   // cache bootstrapper namespaced the key
})
```

The HTTP request path activates the registry inside
`TenantGuardMiddleware`. Queue jobs that wrap their handler in
`tenancy.run()` get the same scoping. The `BackupTenant`,
`InstallTenant`, and `UninstallTenant` jobs already do.

## Available bootstrappers

The package ships **five** bootstrappers under
`src/services/bootstrappers/`. Each one wraps a peer Adonis service:

| Bootstrapper | Service | What it does |
|---|---|---|
| [`cacheBootstrapper`](/docs/bootstrappers/cache) | BentoCache | Namespaces every key by `tenants/<id>/…` |
| [`driveBootstrapper`](/docs/bootstrappers/filesystem) | `@adonisjs/drive` | Prefixes every storage operation with `tenants/<id>/` |
| [`mailBootstrapper`](/docs/bootstrappers/mail) | `@adonisjs/mail` | Switches SMTP credentials and from address per tenant |
| [`sessionBootstrapper`](/docs/bootstrappers/session) | `@adonisjs/session` | Prefixes session keys with the tenant id |
| [`transmitBootstrapper`](/docs/bootstrappers/broadcasting) | `@adonisjs/transmit` | Scopes broadcast channels per tenant |

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
import BootstrapperRegistry from '@adonisjs-lasagna/saas-tenancy/services'

async ready() {
  const registry = await this.app.container.make(BootstrapperRegistry)
  registry.unregister('drive')  // skip even though @adonisjs/drive is installed
}
```

## Order matters

Each bootstrapper has a `priority`. The registry enters in ascending
order and leaves in descending order, exactly like a stack. The
default ordering is:

1. `cache`
2. `drive`
3. `mail`
4. `session`
5. `transmit`

You can override priorities when registering a custom bootstrapper.

## Writing a custom bootstrapper

```ts
import { Bootstrapper, TenantContext } from '@adonisjs-lasagna/saas-tenancy/services'

export class FeatureFlagsBootstrapper implements Bootstrapper {
  priority = 50

  async enter(ctx: TenantContext) {
    // Setup work for this tenant
  }

  async leave(ctx: TenantContext) {
    // Tear down whatever enter() set up
  }
}

// Register in your provider
const registry = await this.app.container.make(BootstrapperRegistry)
registry.register('feature-flags', new FeatureFlagsBootstrapper())
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
