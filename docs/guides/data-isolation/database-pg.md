---
title: database-pg driver
description: One PostgreSQL database per tenant. Strongest OS-level isolation; higher operational cost.
---

# `database-pg` driver

<Callout type="tip" title="When you need it">
Use this driver when compliance or contracts require OS-level
isolation between tenants; separate WAL streams, separate
credentials, the option to host individual tenants on different
machines. Otherwise prefer
[`schema-pg`](/guides/data-isolation/schema-pg).
</Callout>

## What it does

Each tenant gets its own PostgreSQL database named
`tenant_<uuid>` (configurable via `tenantDatabasePrefix`).
Connections are independent; nothing is shared at the database
level.

## Requirements

- The Lucid template connection role must have the **`CREATEDB`**
  privilege.
- `CREATE DATABASE` cannot run inside a transaction. The driver runs
  it outside one; your hooks must too.
- `destroy` calls `pg_terminate_backend` on every active session
  before issuing `DROP DATABASE IF EXISTS` to avoid the classic
  "database is being accessed by other users" failure.

## Configuration

```ts
isolation: {
  driver: 'database-pg',
  tenantDatabasePrefix: 'tenant_', // optional; defaults to tenantSchemaPrefix
  templateConnectionName: 'tenant',
}
```

## Provision flow

1. Validate the tenant id (`assertSafeIdentifier`).
2. `CREATE DATABASE "tenant_<uuid>"` on the template connection (no
   transaction).
3. Register a per-tenant Lucid connection pointed at the new database.
4. Run migrations against it.

## Destroy flow

1. `pg_terminate_backend` on every backend with `datname =
   'tenant_<uuid>'` (excluding the current process).
2. `DROP DATABASE IF EXISTS "tenant_<uuid>"`.
3. Close and unregister the Lucid connection.

## Trade-offs

| Pro | Con |
|---|---|
| Per-tenant credentials and roles | Separate connection pool per tenant; costlier |
| Tenant data lives in different files / WAL | Can't `JOIN` across tenants for reporting |
| Easy to replicate or relocate one tenant | Migrations run N times instead of once |
| `pg_dump` per tenant is a single-database dump | Tenant counts in the thousands strain the connection budget |

## When this driver shines

- **Regulated industries** where data residency or contractual
  separation is non-negotiable.
- **Tenants with vastly different sizes**; putting the largest
  tenant on its own database means it can be relocated to a bigger
  machine without touching the others.

## Operational notes

- Backups should iterate tenants and call `pg_dump` per database,
  not per schema; Lasagna's `tenant:backup` already does this when
  the active driver is `database-pg`.
- Health checks (`tenant:doctor`) include a connectivity probe per
  tenant. With many tenants this becomes a non-trivial pass; use
  `--tenant=<id>` to limit during incidents.


## Read next

- [schema-pg driver](/guides/data-isolation/schema-pg); one schema per tenant, the default.
- [rowscope-pg driver](/guides/data-isolation/rowscope-pg); shared schema with a `tenant_id`.
- [Data isolation](/guides/data-isolation/); how to choose between drivers.
