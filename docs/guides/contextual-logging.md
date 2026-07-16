---
title: Contextual logging
description: AsyncLocalStorage-backed tenant context that rides through HTTP, queue jobs, and any async continuation. Every log line, audit row, and downstream service call sees the active `tenantId` automatically.
---

# Contextual logging

Threading `tenantId` through every function call by hand is the kind
of work that quietly disappears as soon as someone forgets it on a
new code path. Lasagna binds the active tenant to Node's
`AsyncLocalStorage` so the tag rides on the call stack instead: log
lines, audit rows, and downstream services see the tenant id without
you passing it.

## The two primitives

`TenantLogContext` owns the AsyncLocalStorage; `tenancy.run()` is the
public entry point that activates a context outside HTTP:

```ts
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'

await tenancy.run(tenant, async () => {
  // tenancy.currentId() === tenant.id
  // tenantLogger() emits { tenantId } on every line
  // Lucid models extending TenantBaseModel route to this tenant's schema
  // Any async continuation (setTimeout, await fetch, Promise.all) sees the same context
})
```

Inside an HTTP request, `TenantGuardMiddleware` already wraps the
handler in `tenancy.run(...)` for you; every controller, service,
and Lucid call inherits the binding without ceremony. Outside HTTP
(queue jobs, scheduled commands, REPL scripts), you wrap the entry
point yourself.

## tenantLogger()

A thin async wrapper that returns the AdonisJS root logger with the
active tenant context bound to it:

```ts
import { tenantLogger } from '@adonisjs-lasagna/saas-tenancy/services'

const log = await tenantLogger()
log.info({ orderId: order.id }, 'Order created')
// → { tenantId: '...', orderId: '...', msg: 'Order created' }
```

Outside any `tenancy.run()` scope, `tenantLogger()` returns the
plain root logger. There's no penalty for calling it everywhere: if
no context is active, no extra fields are attached.

The wrapper uses Pino's native `child(bindings)` API, so the
serializer chain you've configured for the root logger continues to
apply. No Lasagna-specific format leaks into your dashboards.

## Adding extra context fields

`TenantLogContext.run()` accepts arbitrary key/value pairs alongside
`tenantId`:

```ts
import app from '@adonisjs/core/services/app'
import { TenantLogContext } from '@adonisjs-lasagna/saas-tenancy/services'

const ctx = await app.container.make(TenantLogContext)
await ctx.run({ tenantId, requestId, traceId }, async () => {
  // every log line within this scope carries all three fields
})
```

Stick to fields that are safe to log: don't put PII or secrets here
because they'll show up in every log line.

## Inside queue jobs

Each of the five built-in jobs already wraps its `execute()` in
`tenancy.run()`. If you write your own tenant-aware job, do the same:

```ts
import { Job } from '@adonisjs/queue'
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'

export default class GenerateInvoice extends Job<{ tenantId: string; invoiceId: string }> {
  async execute() {
    const tenant = await loadTenant(this.payload.tenantId)
    return tenancy.run(tenant, async () => {
      const log = await tenantLogger()
      log.info({ invoiceId: this.payload.invoiceId }, 'Generating invoice')
      await renderPdf()
      await uploadToStorage()
    })
  }
}
```

The integration suite proves the propagation works under contention
with 3 tenants × 30 jobs interleaved randomly:
[`tests/@guarantees/behavior/integration/behavior_tenant_context.spec.ts`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/core/tests/@guarantees/behavior/integration/behavior_tenant_context.spec.ts).

## Reading the active tenant

Three flavors, all exported from the package root:

```ts
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'

tenancy.currentId()          // string | undefined — synchronous, cheap
await tenancy.current()      // TenantModelContract | null — hits the repository
```

For one-off log enrichment, use `currentId()`: synchronous, no
container resolution, no DB call:

```ts
const tenantId = tenancy.currentId()
if (tenantId) span.setAttribute('tenant.id', tenantId)
```

For full tenant data in scheduled jobs or background services, use
`tenancy.current()`. It uses `findById(id, true)` so soft-deleted
tenants resolve too, which is useful in cleanup or audit code.

## Nested scopes

`tenancy.run()` and `TenantLogContext.run()` honor a stack: an inner
scope shadows the outer scope while it's active, then the outer is
restored on return. This makes batch processing across tenants
clean:

```ts
for (const tenant of allTenants) {
  await tenancy.run(tenant, () => processOne(tenant))
}
```

Each iteration sees its own context, and nothing leaks into the next.

## Bootstrappers reuse the same hook

Every tenant bootstrapper (cache, drive, mail, session, broadcasting)
implements `enter(ctx)` / `leave(ctx)` and is invoked by
`tenancy.run()` via the `BootstrapperRegistry`. So inside a
`tenancy.run()` scope, the cache namespace, mailer, drive prefix, and
session keys are all already pointing at the active tenant, without
extra wiring. See the [Bootstrappers overview](/guides/bootstrappers/).

## Testing

`TenantLogContext` has zero dependencies, so unit tests can drive it
directly:

```ts
import { TenantLogContext } from '@adonisjs-lasagna/saas-tenancy/services'

test('audit row carries the active tenant', async ({ assert }) => {
  const ctx = new TenantLogContext()
  await ctx.run({ tenantId: 'fake-id' }, async () => {
    assert.equal(ctx.currentTenantId(), 'fake-id')
  })
})
```

The full unit suite at
[`tests/@guarantees/behavior/unit/behavior_tenant_log_context.spec.ts`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/core/tests/@guarantees/behavior/unit/behavior_tenant_log_context.spec.ts)
covers parallel scopes, nested run, async continuation propagation,
and the no-bleed guarantee at scope exit.

## Related

- [Jobs](/guides/jobs); every built-in job wraps work in `tenancy.run()`
- [Concepts](/start/concepts); how AsyncLocalStorage interacts with
  per-tenant Lucid connections
- [Lifecycle events](/reference/events); listeners run inside the dispatching
  scope, so `tenancy.currentId()` is available without extra plumbing
