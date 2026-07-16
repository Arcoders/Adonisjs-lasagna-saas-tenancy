---
title: Database routing
description: How tenant-scoped queries reach the right schema. Handled inside TenantAdapter via the active IsolationDriver, not as a registered bootstrapper.
---

# Database routing

<Callout type="tip" title="Not a bootstrapper">
Unlike cache, drive, mail, session, and transmit, database routing
is <strong>not</strong> implemented as a registered bootstrapper. It
lives inside <code>TenantAdapter</code> and runs synchronously per
query, before any bootstrapper code fires. This page documents the
mechanism for completeness.
</Callout>

## What it does

`TenantAdapter.modelConstructorClient()` is called by Lucid every
time a `TenantBaseModel` query starts. The adapter:

1. Reads the active tenant via `tenancy.currentId()` (or
   `HttpContext.tenant` for HTTP-driven flows).
2. Asks the active `IsolationDriver` for the connection name:
   `tenant_<uuid>` for `schema-pg`, the per-tenant database name for
   `database-pg`, the shared connection plus a `tenant_id` filter for
   `rowscope-pg`.
3. Returns the connection so the query routes there.

## Configuration

Configured indirectly through `isolation.driver`. See
[Data isolation](/guides/data-isolation/).

## Why it isn't a bootstrapper

Bootstrappers run on the `enter` / `leave` cycle of a tenant
context. Database routing happens **per query**, not per context.
Adapter calls are synchronous, frequent, and have to work even for
code paths that never call `tenancy.run()` (controller calls during
HTTP requests rely on `HttpContext.tenant`, not the bootstrapper
registry).

Folding database routing into the bootstrapper registry would add
overhead to every query and make the dependency direction circular,
since bootstrappers depend on the adapter for their own state.

## Error mode

If no driver matches the configured `isolation.driver`, the adapter
throws on the first query with the active driver name in the
message. The request fails with a 5xx. This is louder than silently
falling back to a default and worth the noise.


## Read next

- [Models](/guides/models); the base classes that ride this connection.
- [Read replicas](/guides/read-replicas); routing reads to replicas.
- [Bootstrappers](/guides/bootstrappers/); the rest of the per-tenant services.
