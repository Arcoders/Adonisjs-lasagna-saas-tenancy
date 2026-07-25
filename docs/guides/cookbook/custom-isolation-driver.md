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
import { ISOLATION_CONTRACT_VERSION, assertSafeIdentifier } from '@adonisjs-lasagna/saas-tenancy/services'
import type { IsolationDriver, DestroyOptions, MigrateOptions, MigrateResult, TableLocation } from '@adonisjs-lasagna/saas-tenancy/services'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { QueryClientContract } from '@adonisjs/lucid/types/database'

export class MyDriver implements IsolationDriver {
  readonly name = 'my-driver'

  // Declare the isolation contract version you built against. The registry
  // compares it to the running core's and refuses a driver built for a NEWER
  // contract (it would call methods this core does not provide). Contract v2
  // added the required `tableLocation` method below.
  readonly contractVersion = ISOLATION_CONTRACT_VERSION

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
    opts?: { bypassSoftCap?: boolean }
  ): Promise<QueryClientContract> {
    // Open or register the runtime Lucid connection and return its client.
    // `bypassSoftCap` lets operational paths (provisioning, migrations) skip the
    // optional SOFT connection-cap admission check; ignore it if you have no
    // pool. It does not skip the absolute ceiling, which stays unbypassable.
  }

  async disconnect(tenant: TenantModelContract): Promise<void> {
    // Close it.
  }

  connectionName(tenantId: string): string {
    // Synchronous resolver for the active query's connection.
    return `my-driver:${tenantId}`
  }

  // Required (contract v2). Report WHERE this tenant's tables physically live,
  // as a closed tagged union, so satellites (e.g. the AI vector store) place
  // per-tenant tables without hardcoding a namespace or branching on the driver.
  // Return the variant that matches your storage shape:
  //   { kind: 'schema',   schema,   connectionName }                 a per-tenant schema
  //   { kind: 'database', database, connectionName }                 a per-tenant database
  //   { kind: 'rowscope', scopeColumn, rls, connectionName }         a shared table + tenant_id + RLS
  //   { kind: 'connection', connectionName }                         the connection IS the namespace
  // Keep it pure and synchronous, and assertSafeIdentifier any namespace string.
  tableLocation(tenant: TenantModelContract): TableLocation {
    assertSafeIdentifier(tenant.id)
    return { kind: 'connection', connectionName: this.connectionName(tenant.id) }
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

## Contract version and the `tableLocation` gate

The `IsolationDriver` contract is versioned (`ISOLATION_CONTRACT_VERSION`,
currently `2`). Declare the version you built against via `contractVersion`. At
registration the registry:

- **throws** if your driver declares a *newer* contract than the running core
  (it would call methods the core does not provide),
- **throws** if your driver does not implement `tableLocation()` (a required v2
  member), regardless of the version you declare, including `1` or an omitted
  version, so a driver written before v2 fails loudly at boot rather than at the
  first satellite call,
- **warns** but still registers if you declare an older-but-present contract.

Upgrading a v1 driver is two lines: add `tableLocation()` returning the
placement variant for your storage, and set `contractVersion` to `2`.

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
semver promise. This is the seam a custom isolation strategy builds on. Lasagna
itself ships only the PostgreSQL drivers and is PostgreSQL-only by design; the
seam is a supported public API for a backend you build and maintain yourself,
not a path to a first-party MySQL driver (we do not intend to ship one).


## Read next

- [Data isolation](/guides/data-isolation/); the driver contract you implement.
- [Models](/guides/models); how adapters route through the driver.
- [Cookbook](/guides/cookbook/); more recipes.
