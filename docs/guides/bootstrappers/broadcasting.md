---
title: Broadcasting bootstrapper
description: Per-tenant transmit channels via tenantBroadcast() / tenantChannel(). Subscriptions on tenant A cannot intercept events from tenant B.
---

# Broadcasting bootstrapper

Auto-detected when `@adonisjs/transmit` is installed. It validates the
tenant id at scope entry and gives you channel helpers that scope
broadcasts by tenant.

## What it does

```ts
import { tenantBroadcast, tenantChannel } from '@adonisjs-lasagna/saas-tenancy/services'

await tenantBroadcast('orders/123', { state: 'paid' })
// Actual channel: tenants/<active-tenant-id>/orders/123

tenantChannel('orders/123')
// → 'tenants/<active-tenant-id>/orders/123' — hand this to client
//   subscriptions and authorize() callbacks
```

The scoping is explicit: a direct `transmit.broadcast('orders/123', …)`
publishes on the global channel. Route tenant-facing events through
the helpers.

The channel prefix defaults to `tenants/` and can be changed
programmatically when registering the bootstrapper:
`createTransmitBootstrapper({ prefix: 'org/' })`.

## Why it matters

Without scoping, two tenants sharing the same Transmit/SSE backend
would receive each other's broadcasts. Prefixed channels make the
collision impossible for every event that goes through the helpers.

## Authorization

The helpers handle channel **naming**. Authorization
(who-can-subscribe-to-what) is still your job. Use Transmit's
`channel.authorize()` callbacks; the channel name is already
tenant-prefixed so the only check left is per-channel: does this
user belong to this tenant? Does this user own order 123?

## SSE vs. bidirectional WebSockets

`tenantBroadcast` is **server-to-client** only (Transmit is SSE). When the client
also needs to send messages (chat, collaborative editing, presence), use
the [`@adonisjs-lasagna/websockets`](/guides/cookbook/multi-tenant-websockets)
satellite, which runs socket.io with the same per-tenant isolation (a resolved,
validated tenant at the handshake and tenant context re-entered around every
inbound event). Use SSE when one-way push is enough; it is lighter and needs no
extra dependency.

## Read next

- [Multi-tenant WebSockets](/guides/cookbook/multi-tenant-websockets); the bidirectional counterpart.
- [Bootstrappers](/guides/bootstrappers/); the rest of the per-tenant services.
- [Background jobs](/guides/jobs); dispatching tenant-aware work.
