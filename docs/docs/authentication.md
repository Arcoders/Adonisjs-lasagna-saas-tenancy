---
title: Authentication
description: How tenant auth composes with the package — bring your own auth, resolve the tenant first, and let tenant-scoped user models route to the right schema automatically.
---

# Authentication

Lasagna does not ship an authentication system, and that is deliberate. You
bring your own (AdonisJS `@adonisjs/auth`, a custom guard, an external IdP),
and the package gives it the one thing multi-tenancy needs: the **active tenant
context**, resolved before your auth runs, so tenant-scoped user lookups hit
the right schema with no `tenant_id` plumbing.

<Callout type="warning" title="Resolve the tenant before you authenticate">
Tenant resolution must run <strong>before</strong> your auth middleware. If you
authenticate first, a query against a tenant-scoped <code>User</code> model has
no active tenant and will fail (or, worse, resolve against the wrong context).
Order <code>TenantGuardMiddleware</code> ahead of your auth guard.
</Callout>

## Per-tenant users

The common SaaS shape: each customer has its own set of users. Make your `User`
model extend `TenantBaseModel`, and every auth query routes to the active
tenant's schema automatically:

```ts
// app/models/user.ts
import { TenantBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'

export default class User extends TenantBaseModel {
  // ...columns
}
```

Because the active tenant is resolved first, `auth.use('web').authenticate()`
and `User.verifyCredentials()` read from `tenant_<uuid>.users` without you ever
writing `where('tenant_id', …)`. Sessions are scoped per tenant too — see the
[session bootstrapper](/docs/bootstrappers/session).

## Central and operator users

Not every identity is a tenant user. Operators, support staff, and your own
back-office accounts belong on the **central** or **backoffice** layer, not
inside a tenant schema. Model those with `CentralBaseModel` /
`BackofficeBaseModel` (see [Models](/docs/models)) and authenticate them on
your non-tenant routes, declared with `router.central()` (see
[Routing](/docs/routing)).

## Admin API authentication

The [Admin REST API](/docs/admin-rest-api) is **fail-closed**: it refuses to
mount without an auth middleware you provide, and it asks for a
`resolveAdminActor` callback so every privileged action is attributed to a real
operator in the audit log. The package never assumes who your admins are; you
wire the guard, it records the actor.

## Impersonation

When an operator needs to act *as* a tenant user (to reproduce a bug, for
example), use the [impersonation satellite](/docs/satellites/impersonation)
rather than sharing credentials. Impersonation tokens are time-boxed,
single-use, HMAC-signed, bound to the target tenant, and fully audited.

## Read next

- [Models](/docs/models) — which base class each kind of user belongs to.
- [Routing](/docs/routing) — `tenant()` vs `central()` routes for your auth endpoints.
- [Impersonation](/docs/satellites/impersonation) — operators entering a tenant safely.
- [Tenant identification](/docs/tenant-identification) — how the tenant is resolved per request.
