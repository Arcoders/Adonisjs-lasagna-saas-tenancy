---
title: Multi-tenant WebSockets
description: Bidirectional, tenant-isolated WebSockets on socket.io — resolve the tenant at the handshake, bind tenant context around every event, and scope rooms per tenant.
---

# Multi-tenant WebSockets

Core ships **server→client** broadcasting over SSE
([`tenantBroadcast`](/docs/bootstrappers/broadcasting)). When the client also
needs to *send* messages — chat, presence, live dashboards — use the
`@adonisjs-lasagna/websockets` satellite. It runs [socket.io](https://socket.io)
with the same isolation guarantees as the rest of the package:

- the tenant is resolved and **validated at the handshake** (suspended/deleted
  tenants are refused before a socket opens);
- DB queries inside your event handlers route to the tenant's schema, because
  the satellite re-enters `tenancy.run()` around **every** inbound event;
- every socket joins a per-tenant room, so a stray `emit` can't cross tenants.

## Install

```sh
npm install @adonisjs-lasagna/websockets socket.io
node ace configure @adonisjs-lasagna/websockets
```

`configure` registers the provider in `adonisrc.ts`. The satellite is stateless
— there are no migrations.

## Configure

Add a `websockets` block to `config/multitenancy.ts`:

```ts
websockets: {
  path: '/socket.io',
  cors: { origin: true, credentials: true },
  handshake: {
    authKey: 'tenantId', // browsers: io(url, { auth: { tenantId } })
  },
  // Resolving a client-supplied id is NOT authentication — see "Authorization".
  async authorize(socket, tenant) {
    return true
  },
},
```

`WebSocketsConfig` is exported from the package if you want to type your config
file:

```ts
import type { WebSocketsConfig } from '@adonisjs-lasagna/websockets'
```

### Where the tenant id comes from

The handshake reader tries these sources in order and stops at the first valid
UUID (set any to `false` to disable):

| Source | Default | Use for |
|---|---|---|
| `handshake.auth[authKey]` | `tenantId` | Browsers (cannot set custom WS headers) |
| header `headerKey` | `x-tenant-id` | Server-to-server clients |
| `handshake.query[queryKey]` | disabled | Last resort (leaks into logs) |
| Host subdomain | disabled | `acme.app.com` → `acme`; needs `baseDomain` |

## Client

Browsers send the tenant id in the socket.io `auth` payload — they cannot set
custom headers on the WebSocket upgrade:

```ts
import { io } from 'socket.io-client'

const socket = io('https://app.com', {
  auth: { tenantId: currentTenantId, token: sessionToken },
})

socket.on('connect_error', (err) => {
  // err.message carries the rejection reason: TENANT_REQUIRED, TENANT_NOT_FOUND,
  // TENANT_SUSPENDED, UNAUTHORIZED, or TENANT_UNAVAILABLE (a backend outage —
  // retryable; the raw DB error is logged server-side, never sent to the client).
})
```

## Register handlers — the one rule

socket.io fires event handlers in later event-loop ticks, so a tenant context
set once at connect time does **not** reach them. Register every handler through
`onTenantEvent` (or wrap it with `bindTenant`), which re-enters the tenant scope
around each event. A bare `socket.on(...)` runs with no tenant context and its DB
queries will throw.

```ts
// start/socket.ts
import app from '@adonisjs/core/services/app'
import { TenantSocketServer } from '@adonisjs-lasagna/websockets'
import Message from '#models/message' // a TenantBaseModel

const sockets = await app.container.make(TenantSocketServer)

// onConnection is safe to call here even though the provider attaches socket.io
// later in ready() — callbacks fire as each socket connects.
sockets.onConnection((socket) => {
  // ✅ runs inside tenancy.run(tenant) — Message writes to the tenant's schema
  sockets.onTenantEvent(socket, 'chat:message', async (text: string) => {
    const message = await Message.create({ body: text })
    sockets.broadcastToTenant('chat:message', message) // only this tenant's room
  })

  // ❌ DON'T: no tenant context — Message.create() throws MissingTenantHeaderException
  // socket.on('chat:message', (text) => Message.create({ body: text }))
})
```

`bindTenant` returns the wrapped function if you need it directly (for example to
reply through a socket.io ack):

```ts
socket.on('orders:get', sockets.bindTenant(socket, async (id, ack) => {
  ack(await Order.find(id))
}))
```

## Emitting from elsewhere

Push to a tenant from anywhere on the same node (an HTTP controller, a queue job)
with an explicit id:

```ts
sockets.emitToTenant(tenant.id, 'notification', { kind: 'invoice.paid' })
```

Inside a bound handler, `broadcastToTenant(event, payload)` targets the current
tenant's room automatically.

The provider also disconnects a tenant's live sockets when it is suspended or
deleted (`TenantSuspended` / `TenantDeleted`), so a connection opened while the
tenant was healthy cannot keep streaming afterward. The AdonisJS emitter is
in-process, so this severance fires only in the process that emits the event — if
you suspend tenants from a worker or run multiple HTTP nodes, propagate the
disconnect across nodes (see *Scaling to multiple nodes* below).

## Authorization

Resolving a client-supplied tenant id tells you *which* tenant the client claims
— not that the client is *allowed* to be there. Treat it like the
[broadcasting authorization note](/docs/bootstrappers/broadcasting#authorization):
the `authorize(socket, tenant)` hook is where you verify the connecting principal
actually belongs to the tenant. Validate the session/JWT from
`socket.handshake.auth.token` and check membership; return a falsy value to
reject the upgrade.

## Scaling to multiple nodes

socket.io rooms are per-process. With more than one app instance, install the
[Redis adapter](https://socket.io/docs/v4/redis-adapter/) so `emitToTenant` /
`broadcastToTenant` fan out across nodes:

```sh
npm install @socket.io/redis-adapter
```

Wire it onto `sockets.io` in `start/socket.ts` using your existing Redis
connection. Without it, an emit only reaches sockets on the node that ran it.

The same per-process boundary applies to suspend/delete **severance**: the
provider only disconnects sockets in the process that received the lifecycle
event. If tenant suspension can happen off the HTTP node (a worker, an admin node,
a second replica), bridge it — e.g. publish the tenant id on a Redis channel that
every node subscribes to and calls `sockets.disconnectTenant(id)` on.

## Read next

- [Broadcasting](/docs/bootstrappers/broadcasting); one-way SSE push, when that's enough.
- [Creating a satellite](/docs/cookbook/creating-a-satellite); how this package is built.
- [Background jobs](/docs/jobs); emit to tenants from queue workers.
