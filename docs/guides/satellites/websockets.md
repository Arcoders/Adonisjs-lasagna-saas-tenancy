---
title: WebSockets
description: Multi-tenant, bidirectional WebSockets on socket.io. The tenant is resolved and validated at the handshake, every event handler runs in that tenant's context, and each connection joins a per-tenant room.
---

# WebSockets

<Callout type="warning" title="Not published to npm">
This package lives in the Lasagna repository and is not published. `npm install
@adonisjs-lasagna/websockets` will 404. To use it today, vendor the `packages/websockets`
directory into your app or depend on it through a git reference. It is documented
here because the code is real, MIT, and exercised by the demo app's end-to-end
suite; it is unpublished because maintaining it as a public package is a promise
we are not yet ready to make.
</Callout>

Bidirectional, tenant-isolated realtime on [socket.io](https://socket.io).

The core already does one-way server-to-client push over SSE
([Broadcasting](/guides/bootstrappers/broadcasting), via `tenantBroadcast`). This
satellite adds the other direction, for clients that also need to send messages:
chat, presence, live dashboards, collaborative editing. It keeps the same
isolation guarantees as the rest of Lasagna:

- the tenant is resolved and validated at the handshake, so a suspended, deleted,
  or not-ready tenant is refused before a socket opens;
- DB queries inside your event handlers route to the tenant's schema, because the
  satellite re-enters `tenancy.run()` around every inbound event;
- every socket joins a per-tenant room, so a stray broadcast cannot reach another
  tenant.

This page is the reference. For a step-by-step build (a chat feature plus an e2e
test), see the [Multi-tenant WebSockets cookbook](/guides/cookbook/multi-tenant-websockets).

> Use [Broadcasting](/guides/bootstrappers/broadcasting) when one-way push is
> enough; it is lighter and needs no extra dependency. Use this satellite when
> the client also has to send messages.

## Configuration

WebSockets ships as its own package. It is stateless, so there are no migrations
and no backoffice tables. Vendor it, install `socket.io`, and run its configure hook:

```bash
npm install socket.io
node ace configure @adonisjs-lasagna/websockets   # registers the provider in adonisrc.ts
```

Once installed it is also reachable through core's configure, which knows the
`websockets` short name:

```bash
node ace configure @adonisjs-lasagna/saas-tenancy --with=websockets
```

`socket.io` is an optional peer dependency that loads at runtime. The package
builds and typechecks without it, and the provider logs a notice and stays off
when it is not installed. Declare it in your host `package.json` so dependabot can
bump it.

Add a `websockets` block to `config/multitenancy.ts`:

```ts
websockets: {
  path: '/socket.io',
  cors: { origin: true, credentials: true },
  handshake: {
    authKey: 'tenantId', // browsers: io(url, { auth: { tenantId } })
  },
  // Resolving a client-supplied id is not authentication. See "Authorization".
  // authorize(socket, tenant) { return true },
},
```

`WebSocketsConfig` is exported if you want to type the block:

```ts
import type { WebSocketsConfig } from '@adonisjs-lasagna/websockets'
```

## Config fields

`config.websockets.*`:

| Field | Type | Default | Purpose |
|---|---|---|---|
| `path` | `string?` | `'/socket.io'` | socket.io mount path. |
| `cors` | `object?` | none | Passed straight to socket.io's `ServerOptions.cors`. Browsers on a tenant subdomain are cross-origin to the apex API, so this is usually required in production. |
| `handshake.authKey` | `string \| false` | `'tenantId'` | Key in `handshake.auth`. The recommended source for browsers, which cannot set custom WS headers. Set it to `false` to turn it off. |
| `handshake.headerKey` | `string \| false` | core `tenantHeaderKey` (`x-tenant-id`) | Header to read for server-to-server clients. Defaults to the same key the HTTP `HeaderResolver` uses. Set it to `false` to turn it off. |
| `handshake.queryKey` | `string \| false` | `false` | Query-string param. Off by default, since query strings leak into logs. |
| `handshake.subdomain` | `boolean` | `false` | Derive the id from the leftmost `Host` label. Needs `baseDomain`. |
| `handshake.baseDomain` | `string?` | none | Base domain to strip for `subdomain` resolution, for example `app.com`. |
| `authorize` | `(socket, tenant) => boolean \| Promise<boolean>` | none | Authorization hook (see [Authorization](#authorization)). A falsy return, or a throw, rejects the upgrade. |

## How a connection is isolated

Every upgrade runs through one handshake middleware before the socket is allowed
to connect:

1. Resolve the tenant id from the handshake (`auth`, then header, then query, then
   subdomain; the first valid UUID wins).
2. Load the tenant through your `TenantRepositoryContract`.
3. Fail closed on lifecycle. A suspended, deleted, or not-ready tenant, or one
   whose circuit breaker is open, is refused before a pool is opened. These are
   the same checks `TenantGuardMiddleware` runs.
4. Run the optional `authorize` hook.
5. Connect the tenant's DB pool.
6. Join the per-tenant room (`tenant:<id>`) and store the tenant on
   `socket.data.tenant`.

A rejection arrives at the client as a socket.io `connect_error`, with the reason
in `err.message`:

| Code | Meaning |
|---|---|
| `TENANT_REQUIRED` | No tenant id present in the handshake. |
| `TENANT_NOT_FOUND` | The id is a valid UUID but no such tenant exists. |
| `TENANT_SUSPENDED` | Tenant is suspended or soft-deleted. |
| `TENANT_NOT_READY` | Tenant is still provisioning, or provisioning failed. |
| `CIRCUIT_OPEN` | The tenant's backend circuit breaker is open. |
| `UNAUTHORIZED` | `authorize()` returned a falsy value or threw. |
| `TENANT_UNAVAILABLE` | A backend outage during lookup or connect. Retryable. The raw driver error is logged server-side and never sent to the client. |

## The one rule: bind every handler

socket.io fires `socket.on(...)` handlers in later event-loop ticks, so a tenant
context set once at connect time does not reach them. Register every handler
through `onTenantEvent` (or wrap it with `bindTenant`). Each one re-enters the
tenant scope, and re-checks the tenant connection, around that event. A bare
`socket.on(...)` runs with no tenant context and its DB queries will throw.

```ts
// start/socket.ts
import app from '@adonisjs/core/services/app'
import { TenantSocketServer } from '@adonisjs-lasagna/websockets'
import ChatMessage from '#models/chat_message' // a TenantBaseModel

const sockets = await app.container.make(TenantSocketServer)

// Wire your handlers here. This is safe to call before the provider attaches
// socket.io; the callback fires as each socket connects.
sockets.onConnection((socket) => {
  // Runs inside tenancy.run(tenant): the write lands in tenant_<id>.chat_messages,
  // and broadcastToTenant reaches only this tenant's room.
  sockets.onTenantEvent(socket, 'chat:send', async (text: string) => {
    const message = await ChatMessage.create({ body: text })
    sockets.broadcastToTenant('chat:new', { id: message.id, body: message.body })
  })

  // Do NOT do this: no tenant context, so ChatMessage.create() throws.
  // socket.on('chat:send', (text) => ChatMessage.create({ body: text }))
})
```

If you need the wrapped function directly, for example to reply through a
socket.io ack, `bindTenant` returns it:

```ts
socket.on('orders:get', sockets.bindTenant(socket, async (id, ack) => {
  ack(await Order.find(id)) // runs in the tenant context
}))
```

## Emitting to a tenant

```ts
// From anywhere on the node (an HTTP controller, a queue job), with an explicit id:
sockets.emitToTenant(tenant.id, 'notification', { kind: 'invoice.paid' })

// Inside a bound handler, this targets the current tenant's room:
sockets.broadcastToTenant('chat:new', payload)

// Sever a tenant's live sockets (the provider calls this on suspend and delete):
sockets.disconnectTenant(tenant.id)
```

## Client

Browsers send the tenant id in socket.io's `auth` payload, because they cannot set
custom headers on the WebSocket upgrade:

```ts
import { io } from 'socket.io-client'

const socket = io('https://app.com', {
  auth: { tenantId: currentTenantId, token: sessionToken },
})

socket.emit('chat:send', 'hello')
socket.on('chat:new', (message) => render(message))

socket.on('connect_error', (err) => {
  // err.message is one of the codes in the table above.
})
```

## Authorization

Resolving a client-supplied tenant id tells you which tenant the client claims. It
does not prove the client is allowed there. Use the `authorize(socket, tenant)`
hook to verify the connecting principal actually belongs to the tenant: validate
the session or JWT on `socket.handshake.auth.token` and check membership. Return a
falsy value (or throw) to reject the upgrade. This is the same posture as the
[broadcasting authorization note](/guides/bootstrappers/broadcasting#authorization).

```ts
websockets: {
  async authorize(socket, tenant) {
    const token = socket.handshake.auth?.token
    const user = await verifySession(token)        // your auth
    return Boolean(user) && user.tenantId === tenant.id
  },
},
```

## API surface

`TenantSocketServer` (resolve it with `app.container.make(TenantSocketServer)`):

| Method | Purpose |
|---|---|
| `onConnection(handler)` | Register a per-connection setup callback. Wire your `onTenantEvent` handlers here. |
| `onTenantEvent(socket, event, handler)` | Register an inbound event handler that runs inside the socket's tenant context. Use this for every handler. |
| `bindTenant(socket, fn)` | Wrap a function to run in the socket's tenant context and return it, for acks or custom wiring. |
| `emitToTenant(tenantId, event, …args)` | Emit to every socket of a specific tenant. |
| `broadcastToTenant(event, …args)` | Emit to the current tenant's room. Call it from inside a bound handler. |
| `disconnectTenant(tenantId)` | Sever every socket of a tenant. |
| `close()` | Drain the socket.io server. |
| `io` (getter) | The underlying socket.io `Server`, or `undefined` before `attach()` runs / when socket.io is not installed. Use it to install the Redis adapter for multi-node fan-out (see below). |

`tenantRoom(id)` and `resolveTenantIdFromHandshake(handshake, config)` are also
exported for advanced wiring.

## Scaling to multiple nodes

socket.io rooms are per-process. With more than one app instance, install the
[Redis adapter](https://socket.io/docs/v4/redis-adapter/) so `emitToTenant` and
`broadcastToTenant` fan out across nodes:

```bash
npm install @socket.io/redis-adapter
```

Wire it onto the socket.io server in `start/socket.ts` using your existing Redis
connection. Without it, an emit only reaches sockets on the node that ran it.

The same per-process boundary applies to suspend and delete severance. The
provider disconnects sockets only in the process that received the
`TenantSuspended` or `TenantDeleted` event, because the AdonisJS emitter is
in-process. If tenant suspension can happen off the HTTP node (a worker, an admin
node, a second replica), bridge it yourself. For example, publish the tenant id on
a Redis channel that every node subscribes to, and call `sockets.disconnectTenant(id)`
when it arrives.

## Extensibility: the authorize hook

The `authorize` config is the extension point. It accepts a bare function (the
simple form) or a versioned object `{ contractVersion, authorize }` that opts into
the contract check at wiring time, validated against `WEBSOCKETS_CONTRACT_VERSION`.
A bare function stays unversioned and works as before. See the
[Extensibility standard](/guides/extensibility).

## Read next

- [Multi-tenant WebSockets cookbook](/guides/cookbook/multi-tenant-websockets); the end-to-end build.
- [Broadcasting](/guides/bootstrappers/broadcasting); one-way SSE push, when that is enough.
- [Production checklist](/reference/production-checklist); the hardening runbook before you ship.
- [Creating a satellite](/guides/cookbook/creating-a-satellite); how this package is built.
