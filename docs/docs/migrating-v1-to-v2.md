# Migrating from v1.x to v2.0

> **TL;DR:** v2 introduces a pluggable isolation driver system. The
> `schema-pg` driver is the default and matches v1 behavior. Most apps
> only need to add `isolation: { driver: 'schema-pg' }` to their config
> and delete a few methods from their tenant model. Apps that wired up
> `TenantAdapter` themselves have one constructor change to make.

This guide walks through every breaking change in order of likelihood
of biting you.

## Quick checklist

- [ ] Add `isolation: { driver: 'schema-pg' }` to your multitenancy config.
- [ ] Delete `getConnection`/`closeConnection`/`install`/`uninstall`/
      `migrate`/`dropSchemaIfExists`/`invalidateCache` from your tenant
      model; they were removed from `TenantModelContract` in v2 and the
      package no longer calls them.
- [ ] **Verify your tenant `id` column is UUID v4 or a strict
      alphanumeric (≤ 63 chars).** v2's drivers reject anything that
      could escape a quoted PostgreSQL identifier. If you ever issued
      tenant ids that contain `"`, `;`, spaces, slashes, or other shell
      metacharacters, those tenants need to be re-keyed before upgrade.
- [ ] If your code calls `Model.query()` outside a `tenancy.run()` /
      `unscoped()` scope on a `withTenantScope`-mixin model, it will
      now throw under strict mode (the v2 default). Either wrap the
      call sites or set `isolation.rowScopeMode: 'allowGlobal'`.
- [ ] If you wired your own `TenantAdapter`, pass an
      `IsolationDriverRegistry` to its constructor.
- [ ] Update Node to **>= 24**. The package's `engines` field already
      required this; v2 surfaces dependency code paths that need it.
- [ ] Run `npm run typecheck` and fix any leftover type errors flagged
      against the deprecated methods.

If you are happy with `schema-pg`, that is all. The rest of this guide
covers what changed, why, and how to switch to the new drivers.

---

## What changed and why

v1 hard-wired schema-per-tenant on PostgreSQL: every model query went
through a `TenantAdapter` that built the connection name inline as
`tenantConnectionNamePrefix + tenantId`, and the user's tenant model
owned `getConnection` / `install` / `uninstall` / `migrate` /
`dropSchemaIfExists`. That worked but locked apps into one strategy.

v2 lifts those responsibilities into an `IsolationDriver` interface
with three implementations:

| Driver        | Storage                                           | Best for |
|---------------|---------------------------------------------------|----------|
| `schema-pg`   | One PG schema per tenant on a shared database     | Most SaaS workloads (default) |
| `database-pg` | One PG database per tenant                        | Enterprise tenants needing strict OS-level isolation |
| `rowscope-pg` | Shared schema + `tenant_id` column on every table | Lightweight workloads, large tenant counts, central reporting |

The `TenantAdapter` now asks the active driver for the connection name
on every query. The adapter also reads `tenancy.currentId()` first, so
tenant context activated via `tenancy.run(tenant, fn)` (queue jobs,
scripts, custom commands) works without an HTTP request.

---

## Step 1; Config: add the `isolation` block

```ts
// config/multitenancy.ts
export default {
  // …existing fields…

  isolation: {
    driver: 'schema-pg', // default; set to 'database-pg' or 'rowscope-pg' if you want to switch
    templateConnectionName: 'tenant', // optional, defaults to 'tenant'
  },
}
```

If you omit the `isolation` block entirely, the package falls back to
`{ driver: 'schema-pg' }` so v1 configs keep working.

For `database-pg` you can also set:

```ts
isolation: {
  driver: 'database-pg',
  tenantDatabasePrefix: 'tenant_', // defaults to your tenantSchemaPrefix
}
```

For `rowscope-pg`:

```ts
isolation: {
  driver: 'rowscope-pg',
  rowScopeColumn: 'tenant_id', // default
  rowScopeTables: ['posts', 'comments', 'invoices'], // tables wiped on tenant destroy
}
```

---

## Step 2; Tenant model: delete the deprecated methods

In v1 your tenant model implemented these:

```ts
// v1 — DELETE these methods from your tenant model
getConnection(): QueryClientContract
closeConnection(): Promise<void>
migrate(opts): Promise<any>
install(): Promise<void>
uninstall(): Promise<void>
dropSchemaIfExists(): Promise<void>
invalidateCache(): Promise<void>
```

In v2 these are removed from `TenantModelContract` and the package
never calls them. The active driver does provision/destroy/migrate/
connect/disconnect itself. Delete the methods from your tenant model;
TypeScript will not let you keep stale `implements
TenantModelContract` decorations otherwise.

The status fields and helpers stay on the model:

```ts
// v2 — keep these
declare status: TenantStatus
declare deletedAt: DateTime | null
get isActive() {…}
get schemaName() {…}
suspend(): Promise<void>
activate(): Promise<void>
```

---

## Step 3; `TenantAdapter` constructor change

If your provider was doing this in v1:

```ts
// v1
TenantBaseModel.$adapter = new TenantAdapter(db)
```

v2 needs the driver registry:

```ts
// v2
const drivers = await this.app.container.make(IsolationDriverRegistry)
TenantBaseModel.$adapter = new TenantAdapter(db, drivers)
```

If you use the bundled `MultitenancyProvider` (most apps), this happens
automatically; no change required.

---

## Step 4; `IsolationDriver.connectionName` signature

If any of your code called `driver.connectionName(tenant)` directly,
update it:

```ts
// v1
driver.connectionName(tenant)

// v2
driver.connectionName(tenant.id)
```

The signature changed because `TenantAdapter` resolves names
synchronously and only needs the id. Methods that legitimately need the
full model (`provision`, `destroy`, `connect`, `migrate`) keep their
`TenantModelContract` parameter.

---

## Step 4.5; Strict scope mode (security default)

If you adopt the `withTenantScope` mixin (or already use `rowscope-pg`),
v2 defaults to **strict scope**: a model query outside both
`tenancy.run()` and `unscoped()` throws a `MissingTenantScopeException`
instead of returning rows from every tenant. This catches forgotten
context in jobs, scripts, and tests; exactly where v1 silently leaked.

```ts
// PRODUCTION (HTTP path) — TenantGuardMiddleware sets the scope automatically.
await Post.all() // returns just the active tenant's posts. Fine.

// QUEUE JOB — wrap explicitly.
await tenancy.run(tenant, async () => {
  await Post.all()
})

// ADMIN / CROSS-TENANT REPORT — be explicit about the bypass.
import { unscoped } from '@adonisjs-lasagna/saas-tenancy'
await unscoped(() => Post.all())
```

If your codebase relies on the v1 silent-passthrough behavior, opt out:

```ts
isolation: {
  driver: 'rowscope-pg',
  rowScopeMode: 'allowGlobal', // v1 behavior; tenant scope skipped silently
}
```

We strongly recommend keeping `'strict'` and migrating call sites; the
performance is identical, the bugs it catches are real.

## Step 4.6; Tenant id format

v2's drivers validate `tenant.id` against `/^[a-zA-Z0-9_-]{1,63}$/`
before interpolating it into any DDL (`CREATE SCHEMA "…"`, `DROP DATABASE
"…"`, `searchPath`, etc.). UUID v4; the canonical and recommended id
format; satisfies this. If your app uses some other id scheme, audit
it now: any `"`, `;`, space, slash, or shell metacharacter in a
production tenant id will cause provision/migrate/destroy to throw
`Refusing to use unsafe tenant id`.

If you must allow ids with unusual characters (we don't recommend it),
fork the driver and override `connectionName` / `schemaName` /
`databaseName` with your own escaping strategy.

## Step 5; Switch to a new isolation driver (optional)

### `database-pg`

Requirements:

- The Lucid template connection role must have `CREATEDB`.
- `CREATE DATABASE` cannot run inside a transaction (the driver runs it
  outside one; your hooks must too).
- `destroy` terminates active sessions on the target database with
  `pg_terminate_backend` before issuing `DROP DATABASE IF EXISTS`.

Switch by setting `isolation.driver: 'database-pg'`. No code changes
beyond that; your existing tenant migrations run against the per-
tenant database via the same `tenant:migrate` command.

### `rowscope-pg`

Requirements:

- Every tenant-scoped table must have a `tenant_id` column (or your
  configured `rowScopeColumn`).
- Models that should be tenant-scoped need to opt in via the mixin:

```ts
import { BaseModel, column } from '@adonisjs/lucid/orm'
import { withTenantScope } from '@adonisjs-lasagna/saas-tenancy'

export default class Post extends withTenantScope(BaseModel) {
  @column({ isPrimary: true }) declare id: number
  @column() declare title: string
  // tenant_id is added and managed by the mixin
}
```

The mixin:

- Injects `WHERE tenant_id = <current>` on `find` / `fetch` / `paginate`.
- Auto-fills `tenant_id` on `create`.
- Throws on `update` / `delete` if the row's `tenant_id` differs from
  the active scope (catches accidental cross-tenant writes).

For legitimate cross-tenant operations (admin reports, central
migrations) wrap the work in `unscoped(fn)`:

```ts
import { unscoped } from '@adonisjs-lasagna/saas-tenancy'

await unscoped(async () => {
  return Post.all() // returns rows from every tenant
})
```

Migrations remain central under row-scoping; `tenant:migrate` becomes
a no-op. Run `node ace migration:run` once for the whole app.

---

## Step 6; `tenancy.run(tenant, fn)` for non-HTTP code

v1 only had `request.tenant()` for resolving the active tenant during
HTTP. v2 adds:

```ts
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'

await tenancy.run(tenant, async () => {
  // any package code that reads tenancy.currentId() sees `tenant.id`
  // here. The active isolation driver routes connections accordingly.
  // Bootstrappers (cache, future filesystem/mail/session) are entered
  // before fn() runs and left in reverse order after fn() returns.
})
```

Use this from queue jobs, ace commands, and scripts where there's no
HTTP request. The bundled `InstallTenant` and `UninstallTenant` jobs
already use `TenantLogContext.run()` under the hood; no change needed.

---

## Step 7; New command: `tenant:migrate:fresh`

```bash
node ace tenant:migrate:fresh                 # all tenants (with prompt)
node ace tenant:migrate:fresh --tenant=<id>   # one tenant
node ace tenant:migrate:fresh --force --seed  # CI / scripts
```

DROP and recreate per-tenant storage (calls `driver.reset`), then
re-run migrations. Use `--seed` to invoke `db:seed` per tenant after
migrations finish. **Destructive**; the prompt is only skipped with
`--force`.

For `rowscope-pg`, "reset" means `DELETE FROM <table> WHERE tenant_id`
on every table listed in `rowScopeTables`; migrations are a no-op.

---

## Step 8; Node 24

The `engines` field in `package.json` already required Node >= 24.
Some dependency code paths now use `import … with { type: 'json' }`
syntax which Node 20 cannot parse. Pin your runtime to Node 24+ before
upgrading.

---

## Security improvements you get for free

v2 hardens several attack surfaces that v1 left exposed. None of these
require changes from you, but they're worth knowing about:

- **SQL identifier injection** in `CREATE SCHEMA`/`DROP DATABASE` is
  now rejected at the driver entry, not at the database. Even if some
  upstream layer ever lets a malformed id through, it dies before
  touching SQL.
- **Bulk `Model.query().delete()`** on a `withTenantScope` model can no
  longer wipe rows across tenants when context is missing; strict
  mode catches it.
- **`unscoped(fn)`** is the single, explicit way to opt out. There is
  no implicit fallthrough.
- **`pg_terminate_backend`** runs before `DROP DATABASE` so destroys
  are reliable instead of erroring on "database is being accessed by
  other users".
- **`spawn('psql', …)`** no longer uses `shell: true` on Windows.
  Eliminates the cmd.exe metacharacter interpretation surface.
- **Singleton caches in `tenancy.ts` / `active_driver.ts`** are
  invalidated in the provider's `shutdown()` hook, so test runners and
  hot-reload paths can no longer hold stale references to dead
  containers.

If you ran your own audit of v1 and patched any of these, drop the
patch; v2 covers them.

## Things that did NOT change

- The `TenantBaseModel` / `BackofficeBaseModel` / `CentralBaseModel`
  base classes and their adapters wiring.
- The `request.tenant()` macro; still works the same way; internally
  it now asks the active driver for the connection.
- Every satellite service (audit logs, webhooks, branding, SSO, feature
  flags, metrics, quotas, circuit breaker, read replicas).
- Commands surface; every v1 command still works. New commands were
  added (`tenant:migrate:fresh`).
- The `TenantRepositoryContract` interface gained an `each()` method
  for cursor iteration; implementations must add it. The
  `MockTenantRepository` already does.
- Hooks, events, jobs, doctor checks; unchanged.

---

## Codemod hints

A jscodeshift transform that does steps 1,4 mechanically is on the
roadmap. Until then, the changes are small enough to apply by hand:

```bash
# 1. Find the call sites in your repo
grep -rn 'tenant.getConnection\|tenant.install\|tenant.uninstall\|tenant.migrate\|dropSchemaIfExists' src/

# 2. Each match is dead code: the package no longer calls these.
#    If your own code calls them, replace with the driver:
#       tenant.getConnection() → (await getActiveDriver()).connect(tenant)
#       tenant.install()       → (await getActiveDriver()).provision(tenant)
#       tenant.uninstall()     → (await getActiveDriver()).destroy(tenant)
#       tenant.migrate(opts)   → (await getActiveDriver()).migrate(tenant, opts)
```

Import:

```ts
import { getActiveDriver } from '@adonisjs-lasagna/saas-tenancy/services'
```

---

## Reporting issues

If a v1 pattern you depended on is missing or behaves differently in
v2, please open an issue with a minimal reproducer. Migration friction
is a top priority for the 2.x line.
