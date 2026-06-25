---
title: 'Tutorial 3: Users & authentication'
description: Give each tenant its own users with a tenant-scoped User model, order the tenant guard ahead of auth, and close the cross-tenant access gap with a membership check.
---

# Step 3: Users & authentication

Helpdesk needs support agents, and each company's agents belong to that company alone.
You'll model them as per-tenant users, let your existing auth route to the right schema
automatically, and close the one gap that schema isolation does not cover on its own:
a user of one tenant reaching another tenant's data.

Lasagna ships no authentication system, and that's deliberate. You bring your own (the
AdonisJS `@adonisjs/auth` guards, a custom guard, an external IdP) and the package gives
it the one thing multi-tenancy needs: the active tenant, resolved before your auth runs.

## 1. A per-tenant User model

Make `User` extend `TenantBaseModel`, exactly like `Ticket` from the previous step. Every
auth query against it then routes to the active tenant's schema:

```ts
// app/models/user.ts
import { column } from '@adonisjs/lucid/orm'
import { TenantBaseModel } from '@adonisjs-lasagna/saas-tenancy'

export default class User extends TenantBaseModel {
  @column({ isPrimary: true }) declare id: number
  @column() declare email: string
  @column({ serializeAs: null }) declare password: string
}
```

Add its migration alongside the tickets one in `database/migrations/tenant/`, then
`node ace tenant:migrate` to create a `users` table inside every tenant schema. Two
companies can now both have an `admin@…` user with no collision, because the rows live in
different schemas.

Because the active tenant is resolved first, `auth.use('web').authenticate()` and
`User.verifyCredentials()` read from `tenant_<uuid>.users` without you ever writing
`where('tenant_id', …)`. Sessions are scoped per tenant too; see the
[session bootstrapper](/guides/bootstrappers/session).

## 2. Order the guard ahead of auth

<Callout type="warning" title="Resolve the tenant before you authenticate">
If your auth middleware runs first, a query against the tenant-scoped <code>User</code>
model has no active tenant and fails, or worse, resolves against the wrong context. Put
<code>TenantGuardMiddleware</code> ahead of your auth guard in the middleware stack so the
tenant is established before any user lookup.
</Callout>

You registered the tenant guard in [step 1](/start/tutorial/setup#5-register-the-tenant-guard).
Make sure your auth guard sits after it on the routes that need both.

## 3. Close the cross-tenant gap

Tenant resolution is trust-the-input: the guard verifies the resolved tenant exists and is
active, but it does **not** check that the caller belongs to that tenant. Without a check, a
logged-in user of Acme could swap the `x-tenant-id` header (or hit another tenant's subdomain)
and read a different company's tickets. Close it with one line in config:

```ts
// config/multitenancy.ts — reject callers who don't belong to the resolved tenant
authorizeTenantAccess: (ctx, tenant) => ctx.auth?.user?.tenantId === tenant.id
```

Return `false` (or throw) and the guard denies with a `403`. This is a membership check,
not full RBAC. For users who belong to several tenants, look the pair up in your membership
table instead of comparing a single id. The rationale and the multi-tenant variant are in
[Security › What the host owns](/guides/security#what-the-host-owns).

## 4. Operators are a different layer

Not every identity is a tenant user. Your own support staff and back-office operators don't
live inside any one tenant's schema, so don't model them with `TenantBaseModel`. Put them on
the central or backoffice layer with `CentralBaseModel` / `BackofficeBaseModel` (see
[Models](/guides/models)) and authenticate them on non-tenant routes declared with
`router.central()` (see [Routing](/guides/routing)). When an operator needs to act *as* a
tenant user to reproduce a bug, use the [impersonation satellite](/guides/satellites/impersonation)
rather than sharing credentials; its tokens are time-boxed, single-use, and fully audited.

## Read next

- [Step 4: Billing](/start/tutorial/billing); put the tenants on paid plans.
- [Authentication](/guides/authentication); the full picture of auth composing with tenancy.
- [Security](/guides/security); what the package secures and what stays the host's job.
