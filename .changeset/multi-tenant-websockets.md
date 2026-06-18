---
"@adonisjs-lasagna/websockets": minor
---

New satellite `@adonisjs-lasagna/websockets`: multi-tenant, bidirectional
WebSockets on socket.io. It complements the core SSE broadcasting
(`tenantBroadcast`/`tenantChannel`) with a true client-to-server channel that
stays tenant-isolated.

- A handshake middleware resolves the tenant from the socket.io handshake
  (`auth.tenantId` for browsers, the `x-tenant-id` header, a query param, or a
  Host subdomain, all UUID-validated), loads it via the host's
  `TenantRepositoryContract`, fails closed on suspended/deleted/not-ready/
  circuit-open tenants, runs an optional `authorize(socket, tenant)` hook, opens
  the tenant DB connection, and joins the socket to a per-tenant room.
- `onTenantEvent(socket, event, handler)` / `bindTenant(socket, handler)`
  re-enter `tenancy.run()` around **each** inbound event, so DB queries inside
  handlers route to the tenant's schema. (socket.io fires handlers in later
  event-loop ticks, so a context set once at connect time would not reach them,
  which is why this wrapper is required.)
- `emitToTenant(id, …)`, `broadcastToTenant(…)` (current scope), and
  `disconnectTenant(id)` for tenant-scoped fan-out and mid-session severance;
  the provider wires `TenantSuspended` / `TenantDeleted` to disconnect a tenant's
  live sockets.
- socket.io is an optional peer dependency, lazy-imported at runtime (the package
  builds, typechecks, and unit-tests without it). For multi-node fan-out, add
  `@socket.io/redis-adapter`.
