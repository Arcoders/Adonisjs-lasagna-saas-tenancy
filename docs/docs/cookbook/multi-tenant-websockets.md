---
title: Multi-tenant WebSockets
description: Bidirectional, tenant-isolated WebSockets on socket.io. Resolve the tenant at the handshake, bind tenant context around every event, and scope rooms per tenant.
---

# Multi-tenant WebSockets

The core ships server-to-client broadcasting over SSE
([`tenantBroadcast`](/docs/bootstrappers/broadcasting)). When the client also
needs to send messages (chat, presence, live dashboards), reach for the
`@adonisjs-lasagna/websockets` satellite. It runs [socket.io](https://socket.io)
with the same isolation guarantees as the rest of the package:

- the tenant is resolved and validated at the handshake, so suspended or deleted
  tenants are refused before a socket opens;
- DB queries inside your event handlers route to the tenant's schema, because the
  satellite re-enters `tenancy.run()` around every inbound event;
- every socket joins a per-tenant room, so a stray `emit` cannot cross tenants.

## Install

```sh
npm install @adonisjs-lasagna/websockets socket.io
node ace configure @adonisjs-lasagna/websockets
```

`configure` registers the provider in `adonisrc.ts`. The satellite is stateless,
so there are no migrations.

## Configure

Add a `websockets` block to `config/multitenancy.ts`:

```ts
websockets: {
  path: '/socket.io',
  cors: { origin: true, credentials: true },
  handshake: {
    authKey: 'tenantId', // browsers: io(url, { auth: { tenantId } })
  },
  // Resolving a client-supplied id is not authentication. See "Authorization".
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
UUID. Set any to `false` to turn it off.

| Source | Default | Use for |
|---|---|---|
| `handshake.auth[authKey]` | `tenantId` | Browsers, which cannot set custom WS headers |
| header `headerKey` | `x-tenant-id` | Server-to-server clients |
| `handshake.query[queryKey]` | disabled | Last resort (it leaks into logs) |
| Host subdomain | disabled | `acme.app.com` gives `acme`; needs `baseDomain` |

## Client

Browsers send the tenant id in the socket.io `auth` payload, since they cannot set
custom headers on the WebSocket upgrade:

```ts
import { io } from 'socket.io-client'

const socket = io('https://app.com', {
  auth: { tenantId: currentTenantId, token: sessionToken },
})

socket.on('connect_error', (err) => {
  // err.message carries the rejection reason: TENANT_REQUIRED, TENANT_NOT_FOUND,
  // TENANT_SUSPENDED, UNAUTHORIZED, or TENANT_UNAVAILABLE. The last one is a
  // backend outage and is retryable; the raw DB error is logged server-side and
  // never sent to the client.
})
```

## The one rule for handlers

socket.io fires event handlers in later event-loop ticks, so a tenant context set
once at connect time does not reach them. Register every handler through
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
// later. The callback fires as each socket connects.
sockets.onConnection((socket) => {
  // Runs inside tenancy.run(tenant), so Message writes to the tenant's schema.
  sockets.onTenantEvent(socket, 'chat:message', async (text: string) => {
    const message = await Message.create({ body: text })
    sockets.broadcastToTenant('chat:message', message) // only this tenant's room
  })

  // Do NOT do this: no tenant context, so Message.create() throws
  // MissingTenantHeaderException.
  // socket.on('chat:message', (text) => Message.create({ body: text }))
})
```

`bindTenant` returns the wrapped function if you need it directly, for example to
reply through a socket.io ack:

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
tenant's room.

The provider also disconnects a tenant's live sockets when it is suspended or
deleted (`TenantSuspended` and `TenantDeleted`), so a connection opened while the
tenant was healthy cannot keep streaming afterward. The AdonisJS emitter is
in-process, so this severance fires only in the process that emits the event. If
you suspend tenants from a worker or run multiple HTTP nodes, propagate the
disconnect across nodes (see [Scaling to multiple nodes](#scaling-to-multiple-nodes)).

## Authorization

Resolving a client-supplied tenant id tells you which tenant the client claims. It
does not prove the client is allowed there. Treat it like the
[broadcasting authorization note](/docs/bootstrappers/broadcasting#authorization):
the `authorize(socket, tenant)` hook is where you verify the connecting principal
actually belongs to the tenant. Validate the session or JWT from
`socket.handshake.auth.token` and check membership, then return a falsy value to
reject the upgrade.

## Scaling to multiple nodes

socket.io rooms are per-process. With more than one app instance, install the
[Redis adapter](https://socket.io/docs/v4/redis-adapter/) so `emitToTenant` and
`broadcastToTenant` fan out across nodes:

```sh
npm install @socket.io/redis-adapter
```

Wire it onto the socket.io server in `start/socket.ts` using your existing Redis
connection. Without it, an emit only reaches sockets on the node that ran it.

The same per-process boundary applies to suspend and delete severance: the
provider only disconnects sockets in the process that received the lifecycle
event. If tenant suspension can happen off the HTTP node (a worker, an admin node,
a second replica), bridge it yourself. For example, publish the tenant id on a
Redis channel that every node subscribes to, and call `sockets.disconnectTenant(id)`
when it arrives.

## Read next

- [WebSockets satellite](/docs/satellites/websockets); the reference for config fields, connect_error codes, and the full API surface.
- [Broadcasting](/docs/bootstrappers/broadcasting); one-way SSE push, when that is enough.
- [Creating a satellite](/docs/cookbook/creating-a-satellite); how this package is built.
- [Background jobs](/docs/jobs); emit to tenants from queue workers.
