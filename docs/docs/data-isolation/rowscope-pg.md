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

The mixin injects the tenant filter as flat top-level predicates. Because SQL
binds `AND` tighter than `OR`, a query that introduces top-level `OR` branches
can leave a branch outside the tenant filter and leak other tenants' rows:

```ts
// UNSAFE → the `featured` branch is not tenant-scoped, so other tenants'
// featured rows come back. Roughly:
//   WHERE (tenant_id = X AND a = 1) OR featured = true OR (b = 2 AND tenant_id = X)
await Post.query().where('a', 1).orWhere('featured', true).orWhere('b', 2)
```

Always wrap `OR` branches in a group so the tenant predicate covers all of them:

```ts
// SAFE → WHERE (a = 1 OR featured = true OR b = 2) AND tenant_id = X
await Post.query().where((q) => q.where('a', 1).orWhere('featured', true).orWhere('b', 2))
```

Treat any non-grouped top-level `orWhere` as unsafe. This is a fundamental
limitation of injecting a scope through query hooks: they run after your clauses
are composed, so they cannot retroactively group them. The mixin protects the
common AND-only queries, but it cannot police a top-level `orWhere` you write
yourself.

## Hard boundary: PostgreSQL Row-Level Security

The mixin is a convenience: it scopes the common AND-only queries but cannot
police a top-level `orWhere` you write yourself. If you cannot guarantee every
query author groups their `OR` branches, enforce isolation at the database with
Row-Level Security. RLS holds regardless of how a query is composed, so a
forgotten or escaped scope can no longer leak across tenants.

This package ships the migration and the runtime helpers to wire it up.

### 1. Publish and run the policy migration

```bash
node ace configure @adonisjs-lasagna/saas-tenancy --with=rls
```

That publishes `*_enable_rls_tenant_isolation.ts`. Edit the two constants at the
top to match your app, then migrate:

```ts
const TABLES = ['posts', 'comments', 'invoices'] // mirror isolation.rowScopeTables
const TENANT_COLUMN = 'tenant_id' // mirror isolation.rowScopeColumn
```

For each table the migration enables **and forces** RLS and creates a
fail-closed policy:

```sql
ALTER TABLE "public"."posts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."posts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "public"."posts"
  USING ("tenant_id"::text = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("tenant_id"::text = nullif(current_setting('app.tenant_id', true), ''));
```

When `app.tenant_id` is unset — or reset to `''` after a prior transaction on a
reused pooled connection — `nullif(...)` makes the predicate `NULL`, so it
matches nothing and `WITH CHECK` blocks the insert. A forgotten scope returns
zero rows instead of leaking, which is the point.

<Callout type="warning" title="Run your app without SUPERUSER / BYPASSRLS">
<code>FORCE ROW LEVEL SECURITY</code> makes the policy apply to the table owner
too (apps usually connect as the owner). But a role with <code>SUPERUSER</code>
or <code>BYPASSRLS</code> skips RLS entirely — give your app's runtime role
neither attribute, or the policy is silently inert.
</Callout>

### 2. Set the tenant per transaction

The policy reads a per-transaction setting. `withTenantRls()` opens a
transaction, sets it (transaction-local, so it resets on commit/rollback — the
only pooling-safe choice), and hands you the `trx`:

```ts
import { withTenantRls } from '@adonisjs-lasagna/saas-tenancy'

await withTenantRls(tenant.id, async (trx) => {
  // RLS scopes this to the active tenant even with a top-level orWhere —
  // the database policy enforces it, not the query.
  return trx.from('posts').where('a', 1).orWhere('featured', true)
})
```

**Pass `trx` to every scoped query inside the callback** (a raw `trx.from(...)`
builder, or `model.useTransaction(trx)`). A query that ignores `trx` runs on a
different pooled connection where the setting is not set, so RLS returns zero
rows for it — no leak, but no data either. That fail-closed miss is the
deliberate trade for shape-independent isolation.

If you already manage your own request transaction, set the value directly with
`setTenantRlsGuc(trx, tenant.id)` instead. If your app sets a custom `gucName`,
it must match the `current_setting(...)` name in the migration, or the policy
reads an unset setting and every query silently returns nothing.

<Callout type="warning" title="withTenantRls does not open a tenancy.run() scope">
<code>withTenantRls</code> only sets the database setting. It does <em>not</em>
activate the application tenant scope, so a <code>withTenantScope</code> model
used inside the callback still needs an active <code>tenancy.run()</code> (the
HTTP guard provides one) or an <code>unscoped()</code> wrapper — otherwise the
mixin's strict-scope guard throws before any SQL runs, and create auto-fill
won't populate <code>tenant_id</code>. Combine them, e.g.
<code>tenancy.run(tenant, () =&gt; withTenantRls(tenant.id, (trx) =&gt; …))</code>:
the mixin scopes reads/writes and auto-fills, while RLS is the database backstop
for any <code>orWhere</code> the mixin can't group.
</Callout>

RLS and the `withTenantScope` mixin then compose: the mixin gives ergonomics
(auto-fill on create, the strict-scope guard) and RLS is the boundary that does
not depend on query-author discipline.

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
