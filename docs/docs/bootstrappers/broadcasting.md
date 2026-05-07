---
title: Broadcasting bootstrapper
description: Per-tenant transmit channels. Subscriptions on tenant A cannot intercept events from tenant B.
---

# Broadcasting bootstrapper

Auto-detected when `@adonisjs/transmit` is installed. Scopes
broadcast channels by tenant; every `transmit.broadcast(...)` and
`transmit.subscribe(...)` is silently rewritten to a tenant-local
channel.

## What it does

```ts
transmit.broadcast('orders/123', { state: 'paid' })
// Actual channel: tenants/<active-tenant-id>/orders/123
```

```ts
// Client-side
client.subscription('orders/123').create()
// Server-side: subscribes to tenants/<active-tenant-id>/orders/123
```

## Why it matters

Without scoping, two tenants sharing the same Transmit/SSE backend
would receive each other's broadcasts. The bootstrapper makes the
mistake structurally impossible.

## Configuration

```ts
// config/multitenancy.ts
export default defineConfig({
  transmit: {
    enabled: true,
    prefix: 'tenants/{id}/',
  },
})
```

## Authorization

The bootstrapper handles channel **naming**. Authorization
(who-can-subscribe-to-what) is still your job. Use Transmit's
`channel.authorize()` callbacks; the channel name is already
tenant-prefixed so the only check left is per-channel; does this
user belong to this tenant? Does this user own order 123?
