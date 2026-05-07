---
title: schema-pg driver
description: One PostgreSQL schema per tenant. The default driver; strongest balance of isolation, backup ergonomics, and operational cost.
---

# `schema-pg` driver

<Callout type="tip" title="Default for a reason">
Schemas are a Postgres-native concept. Backups, restores, drops, and
replicas are first-class. <code>schema-pg</code> is the right choice
unless you have a specific reason to pick something else.
</Callout>

## What it does

Each tenant lives in its own schema named `tenant_<uuid>` on a shared
database. Lucid connections are named `tenant_<uuid>` as well; the
adapter activates the right one before each query leaves the process.

## Provision flow

1. Validate the tenant id with `assertSafeIdentifier`.
   `[a-zA-Z0-9_-]{1,63}`.
2. `CREATE SCHEMA "tenant_<uuid>"` on the shared template connection.
3. Register a Lucid connection `tenant_<uuid>` with `searchPath:
   tenant_<uuid>` derived from the template config.
4. Run the per-tenant migrations.

## Destroy flow

1. Mark the tenant as `deleted_at` (soft delete).
2. After the retention window elapses, `tenant:purge-expired` calls
   `driver.destroy()`:
   - `pg_terminate_backend` against any sessions on the schema.
   - `DROP SCHEMA "tenant_<uuid>" CASCADE`.
   - Close and unregister the Lucid connection.

## Configuration

```ts
isolation: {
  driver: 'schema-pg',
  templateConnectionName: 'tenant', // optional, defaults to 'tenant'
}
```

The template connection is the Lucid connection the driver clones to
build per-tenant connections from. Define it in `config/database.ts`:

```ts
tenant: {
  client: 'pg',
  connection: {
    host: env.get('DB_HOST'),
    user: env.get('DB_USER'),
    password: env.get('DB_PASSWORD'),
    database: env.get('DB_DATABASE'),
  },
}
```

## When to pick another driver

- **You need strict OS-level isolation** (per-tenant `CREATEDB` /
  separate WAL stream / per-tenant credentials) → use
  [`database-pg`](/docs/data-isolation/database-pg).
- **You have hundreds of thousands of tiny tenants** and want a
  single connection pool plus central reporting → use
  [`rowscope-pg`](/docs/data-isolation/rowscope-pg).
- **You're writing unit tests** and don't want a real PG → use
  [`sqlite-memory`](/docs/data-isolation/sqlite-memory).

## Operational notes

- `pg_dump --schema=tenant_<uuid>` produces a portable per-tenant
  archive. Lasagna's [`tenant:backup`](/docs/commands#tenant-backup)
  command uses exactly this.
- Schemas don't share connection pools by default; but they share a
  database, so the underlying pool is the template connection's pool.
  Tune it accordingly.
- Migrations are tracked per schema using a per-tenant Lucid migrations
  table.
