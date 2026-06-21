---
title: Session bootstrapper
description: Tenant-prefixed session keys via tenantSession() / tenantSessionKey(). Auto-detected when @adonisjs/session is installed.
---

# Session bootstrapper

Auto-detected when `@adonisjs/session` is installed. It validates the
tenant id at scope entry and gives you tenant-prefixed session
helpers, so two tenants on the same origin cannot collide on a
session key.

## What it does

```ts
import { tenantSession, tenantSessionKey } from '@adonisjs-lasagna/saas-tenancy/services'

const session = tenantSession(ctx)
session.put('cart', cart)
// Actual session key written: tenants/<active-tenant-id>/cart

// or build the key yourself for direct session access:
ctx.session.get(tenantSessionKey('cart'))
```

The scoping is explicit: a direct `ctx.session.put('cart', …)` writes
the global `cart` key. Use the helpers anywhere session state is
tenant-specific.

## When you don't need it

If you're using subdomain-based routing and serve each tenant from a
distinct origin (`acme.app.example.com`, `globex.app.example.com`),
browsers already partition cookies by host, so session collision
across tenants is impossible. Skip the helpers in that case, and if
you want the registry slot gone entirely:

```ts
const registry = await this.app.container.make(BootstrapperRegistry)
registry.unregister('session')
```

## When you do

Path-based routing (`/<uuid>/...`) on a single origin shares cookies
across all tenants. Without tenant-prefixed keys, a session value set
in tenant A's context would be visible in tenant B's.

## Read next

- [Authentication](/docs/authentication); sessions scoped to the active tenant.
- [Bootstrappers](/docs/bootstrappers/); the rest of the per-tenant services.
