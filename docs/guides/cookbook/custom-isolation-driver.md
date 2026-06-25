---
title: Custom isolation driver
description: Implement IsolationDriver from scratch. The registry takes anything that satisfies the contract.
---

# Custom isolation driver

The four shipped drivers; `schema-pg`, `database-pg`,
`rowscope-pg`, `sqlite-memory`; cover the common cases. If your
storage shape doesn't fit (per-tenant DynamoDB tables, a SaaS
metadata service, an external sharder), implement your own driver
and register it.

## The contract

```ts
import type { IsolationDriver, DestroyOptions, MigrateOptions, MigrateResult } from '@adonisjs-lasagna/saas-tenancy/services'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { QueryClientContract } from '@adonisjs/lucid/types/database'

export class MyDriver implements IsolationDriver {
  readonly name = 'my-driver'

  async provision(tenant: TenantModelContract): Promise<void> {
    // Create the tenant's storage. Idempotent: the package may retry.
  }

  async destroy(tenant: TenantModelContract, opts?: DestroyOptions): Promise<void> {
    // Tear it down cleanly. `opts.keepData` is the recycle-bin pattern
    // (`tenant:destroy --keep-schema`): mark, don't delete.
  }

  async reset(tenant: TenantModelContract): Promise<void> {
    // Drop and recreate. Used by `tenant:migrate:fresh`.
    await this.destroy(tenant)
    await this.provision(tenant)
  }

  async connect(
    tenant: TenantModelContract,
    opts?: { bypassHardCap?: boolean }
  ): Promise<QueryClientContract> {
    // Open or register the runtime Lucid connection and return its client.
    // `bypassHardCap` lets operational paths (provisioning, migrations) skip the
    // optional connection-cap admission check; ignore it if you have no pool.
  }

  async disconnect(tenant: TenantModelContract): Promise<void> {
    // Close it.
  }

  connectionName(tenantId: string): string {
    // Synchronous resolver for the active query's connection.
    return `my-driver:${tenantId}`
  }

  // Optional. Called on every query routing to refresh the in-use grace window
  // so a long request is not evicted mid-flight. Omit it if your driver has no
  // per-tenant connection pool.
  markUsed?(tenantId: string): void {
    // refresh last-used timestamp
  }

  async migrate(tenant: TenantModelContract, opts: MigrateOptions): Promise<MigrateResult> {
    // Run migrations against this tenant's storage. Drivers that
    // don't own per-tenant migrations return { executed: 0, noop: true }.
    return { executed: 0, noop: true }
  }
}
```

## Registering it

Plug the driver into the registry from your provider; the registry
keys it by `driver.name`:

```ts
// providers/app_provider.ts
import { IsolationDriverRegistry } from '@adonisjs-lasagna/saas-tenancy/services'
import { MyDriver } from '#drivers/my_driver'

export default class AppProvider {
  async boot() {
    const registry = await this.app.container.make(IsolationDriverRegistry)
    registry.register(new MyDriver())
  }
}
```

Then point the config at it:

```ts
// config/multitenancy.ts
export default defineConfig({
  isolation: {
    driver: 'my-driver',
  },
})
```

## Validate the tenant id

Always call `assertSafeIdentifier(tenant.id)` before interpolating
the id into anything that could escape; DDL, file paths, command
arguments, headers. The shipped drivers do this at every entry. The
helper enforces `[a-zA-Z0-9_-]{1,63}`; UUID v4 always passes.

```ts
import { assertSafeIdentifier } from '@adonisjs-lasagna/saas-tenancy/services'

async provision(tenant) {
  assertSafeIdentifier(tenant.id)
  // …
}
```

## Idempotency contract

- `provision` can be called more than once. Treat the second call as
  a no-op when the storage exists.
- `destroy` runs after `disconnect`. Don't assume the connection is
  still open.
- `reset` is `destroy` + `provision`. The default implementation is
  almost always right.

## Tests to write

- A test against a fake tenant id that should fail
  `assertSafeIdentifier`; ensure your driver throws.
- A test for the connection-name format; synchronous, deterministic,
  no side effects.
- An integration test that round-trips a tenant through `provision`
  → `connect` → run a query → `disconnect` → `destroy`.

## Don't over-fit

If your driver's behaviour is "schema-pg, but with a different
naming convention" or "schema-pg, but with extra `GRANT` calls", you
almost always want to compose. Wrap `SchemaPgDriver` in your driver
and delegate, overriding only what you need. Forking the whole
thing means keeping up with bug fixes that we ship; composition
keeps you on the upgrade path.

## Stability of this contract

The `IsolationDriver` interface and `IsolationDriverRegistry` are a supported
public extension point, exported from
`@adonisjs-lasagna/saas-tenancy/services`. They carry the same
`release-candidate` stability as the isolation core (see
[Stability](/reference/stability)): the shape is considered final under the 1.x
semver promise. This is the seam additional storage backends build on. A MySQL
satellite, when it lands, will be a driver registered here rather than a change
to the core (see the [roadmap](/reference/roadmap)).


## Read next

- [Data isolation](/guides/data-isolation/); the driver contract you implement.
- [Models](/guides/models); how adapters route through the driver.
- [Cookbook](/guides/cookbook/); more recipes.
