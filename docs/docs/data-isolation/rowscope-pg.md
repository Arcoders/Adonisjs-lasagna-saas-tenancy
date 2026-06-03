---
title: rowscope-pg driver
description: Shared schema with a tenant_id column on every table. Strict scope by default; wraps every query in WHERE tenant_id = current.
---

# `rowscope-pg` driver

<Callout type="tip" title="Pick this when you must">
Use <code>rowscope-pg</code> when you have many tiny tenants, write
throughput is the bottleneck, or you need cross-tenant reporting
without a fan-out. The trade-off is one accidental missing scope
away from a data leak; strict mode catches the obvious cases, but
read your code carefully.
</Callout>

## What it does

Every tenant-scoped table includes a `tenant_id` column (configurable
via `rowScopeColumn`). Models opt in via the `withTenantScope` mixin,
which:

- Injects `WHERE tenant_id = <current>` on `find` / `fetch` /
  `paginate`.
- Auto-fills `tenant_id` on `create`.
- Throws on `update` / `delete` if the row's `tenant_id` differs from
  the active scope.

## Configuration

```ts
isolation: {
  driver: 'rowscope-pg',
  rowScopeColumn: 'tenant_id', // default
  rowScopeTables: ['posts', 'comments', 'invoices'], // tables wiped on destroy
  rowScopeMode: 'strict', // 'strict' | 'allowGlobal'
}
```

## Strict scope (default)

A query that runs outside both `tenancy.run()` and `unscoped()`
throws a `MissingTenantScopeException` instead of returning rows
from every tenant. This catches forgotten context in jobs, scripts,
and tests; exactly where v1 silently leaked.

```ts
// HTTP path — TenantGuardMiddleware sets the scope automatically.
await Post.all() // returns just the active tenant's posts. Fine.

// QUEUE JOB — wrap explicitly.
await tenancy.run(tenant, async () => {
  await Post.all()
})

// ADMIN / CROSS-TENANT REPORT — be explicit about the bypass.
import { unscoped } from '@adonisjs-lasagna/saas-tenancy'
await unscoped(() => Post.all())
```

## Opt-out (not recommended)

```ts
isolation: {
  driver: 'rowscope-pg',
  rowScopeMode: 'allowGlobal', // v1 silent-passthrough
}
```

Allowed for legacy migration only. Strict catches real bugs.

## The mixin

```ts
import { BaseModel, column } from '@adonisjs/lucid/orm'
import { withTenantScope } from '@adonisjs-lasagna/saas-tenancy'

export default class Post extends withTenantScope(BaseModel) {
  @column({ isPrimary: true }) declare id: number
  @column() declare title: string
  // tenant_id is added and managed by the mixin
}
```

## SECURITY: group your `OR` branches

The mixin injects the tenant filter as a single top-level
`AND tenant_id = <current>`. Because SQL binds `AND` tighter than `OR`, a
query that adds a top-level `orWhere` lets the tenant predicate apply to only
one branch, leaking other tenants' rows:

```ts
// UNSAFE → WHERE published = true OR (featured = true AND tenant_id = X)
await Post.query().where('published', true).orWhere('featured', true)
```

Always wrap `OR` branches in a group so the tenant predicate covers all of them:

```ts
// SAFE → WHERE (published = true OR featured = true) AND tenant_id = X
await Post.query().where((q) => q.where('published', true).orWhere('featured', true))
```

This is a fundamental limitation of injecting a scope through query hooks: they
run after your clauses are composed, so they cannot retroactively group them.
The mixin protects the common AND-only queries, but it cannot police a
top-level `orWhere` you write yourself.

<Callout type="warning" title="For a hard boundary, add Row-Level Security">
If you cannot guarantee every query author groups their <code>OR</code>
branches, treat the mixin as a convenience and enforce isolation at the
database with PostgreSQL Row-Level Security. Enable RLS on each scoped table
and add a policy keyed on a per-connection setting, e.g.
<code>USING (tenant_id = current_setting('app.tenant_id')::uuid)</code>, then
<code>SET app.tenant_id</code> at the start of each tenant request/transaction.
RLS holds regardless of how the query is composed, so a forgotten or escaped
scope can no longer leak across tenants.
</Callout>

## Destroy flow

`destroy(tenant)` runs `DELETE FROM <table> WHERE tenant_id = ?` for
every table listed in `rowScopeTables`. There is no `DROP SCHEMA` /
`DROP DATABASE`. Migrations are central; `tenant:migrate` becomes a
no-op.

## Trade-offs

| Pro | Con |
|---|---|
| Single connection pool; scales to 100k+ tenants | One missing scope leaks across tenants |
| Reporting is trivial: `SELECT … FROM posts` | Bigger indexes; `tenant_id` is in every key |
| Migrations run once for the whole app | You own the discipline of always wrapping with `tenancy.run()` |
| `unscoped()` makes admin work explicit | Backups are not per-tenant by default |

## Backups under row-scope

`pg_dump` of the whole database backs up every tenant. For
per-tenant restore semantics, build your own export pipeline that
filters by `tenant_id`; Lasagna's bundled `tenant:backup` is
schema-aware and won't be useful here.
