---
title: Session bootstrapper
description: Prefixes session keys with the tenant id. Auto-detected when @adonisjs/session is installed.
---

# Session bootstrapper

Auto-detected when `@adonisjs/session` is installed. Prefixes every
session read and write so two tenants on the same host cannot
collide on a session key.

## What it does

```ts
session.put('cart', cart)
// Actual session key written: tenants/<active-tenant-id>/cart
```

The mechanism is a wrapper around the session facade. Anywhere the
host app reads `request.session.get('foo')`, the bootstrapper
rewrites the key on the fly.

## When you don't need it

If you're using subdomain-based routing and serve each tenant from a
distinct origin (`acme.app.example.com`, `globex.app.example.com`),
browsers already partition cookies by host, so session collision
across tenants is impossible. The bootstrapper is harmless in that
case but contributes nothing; disable it to remove the wrapping
layer:

```ts
bootstrappers: { session: false }
```

## When you do

Path-based routing (`/<uuid>/...`) on a single origin shares cookies
across all tenants. Without this bootstrapper, a session key set in
tenant A would be visible to tenant B.

## Custom prefix

```ts
session: {
  enabled: true,
  prefix: 't:{id}:', // default is 'tenants/{id}/'
}
```
