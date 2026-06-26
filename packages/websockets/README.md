# @adonisjs-lasagna/websockets

Multi-tenant, bidirectional WebSockets on [socket.io](https://socket.io) for
[`@adonisjs-lasagna/saas-tenancy`](https://www.npmjs.com/package/@adonisjs-lasagna/saas-tenancy).

[![Stability: release candidate](https://img.shields.io/badge/stability-release_candidate-C26A4B)](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/reference/stability)

> **Stability: release candidate.** The API is frozen under the 1.x promise, with the honest caveat that a correction forced by the pending security review or production mileage may land in a 1.x minor with a loud changelog entry. Pin the version and read the changelog before upgrading. See the [stability matrix](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/reference/stability).

The core ships one-way server-to-client broadcasting over SSE (`tenantBroadcast`).
This satellite adds the bidirectional channel for chat, presence, and live
dashboards, with the same isolation guarantees:

- The tenant is resolved and validated at the handshake (`auth.tenantId` for
  browsers, the `x-tenant-id` header, a query param, or a Host subdomain, always
  UUID-checked), loaded via the host's `TenantRepositoryContract`, and refused
  when it is suspended, deleted, not-ready, or has an open backend circuit.
- `onTenantEvent(socket, event, handler)` and `bindTenant(socket, handler)`
  re-enter `tenancy.run()` around every inbound event, so DB queries inside
  handlers route to the tenant's schema. socket.io fires handlers in later
  event-loop ticks, so a context set once at connect time would not reach them.
  This wrapper is required.
- Each socket joins a per-tenant room. `emitToTenant(id, …)`,
  `broadcastToTenant(…)`, and `disconnectTenant(id)` keep fan-out scoped, and the
  provider severs a tenant's live sockets on `TenantSuspended` / `TenantDeleted`.
- An optional `authorize(socket, tenant)` hook is the seam for real
  authentication. Resolving a client-supplied id is not, on its own, proof the
  client belongs to the tenant.

## Install

```bash
npm i @adonisjs-lasagna/websockets socket.io
node ace configure @adonisjs-lasagna/websockets
```

`socket.io` is an optional peer, loaded at runtime. For multi-node fan-out, add
[`@socket.io/redis-adapter`](https://socket.io/docs/v4/redis-adapter/).

## Wire it up

`configure` registers the provider in `adonisrc.ts`, alongside the core provider:

```ts
providers: [
  // ...
  () => import('@adonisjs-lasagna/saas-tenancy/providers/multitenancy_provider'),
  () => import('@adonisjs-lasagna/websockets/provider'),
],
```

Add a `websockets` block to `config/multitenancy.ts`.

## Usage

Resolve the server from the container and register handlers through
`server.onTenantEvent` (or `server.bindTenant`) so DB queries inside them route to
the tenant's schema:

```ts
import { TenantSocketServer } from '@adonisjs-lasagna/websockets'

const server = await app.container.make(TenantSocketServer)

server.onConnection((socket) => {
  // Correct: re-enters the tenant context for every inbound event.
  server.onTenantEvent(socket, 'order:create', async (payload) => {
    await Order.create(payload) // hits the tenant's schema
  })

  // Wrong: a bare socket.on runs with no tenant context, so a DB
  // query inside it throws at query time.
  socket.on('order:create', async (payload) => {
    await Order.create(payload) // throws: no tenant bound
  })
})
```

See the
[Multi-tenant WebSockets cookbook](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/guides/cookbook/multi-tenant-websockets)
for the full walkthrough.

## Full documentation

<https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/guides/satellites/websockets>
