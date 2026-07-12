---
title: Authentication
description: How tenant auth composes with the package; bring your own auth, resolve the tenant first, and let tenant-scoped user models route to the right schema automatically.
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
writing `where('tenant_id', …)`. Sessions are scoped per tenant too; see the
[session bootstrapper](/guides/bootstrappers/session).

## Two auth realms: operator and tenant

Not every identity is a tenant user. Operators, support staff, and your own
back-office accounts belong on the **central** or **backoffice** layer, not
inside a tenant schema. Treat the two populations as separate auth **realms**:
one guard, one user model, one token store, and one login surface per plane,
sharing nothing. Lasagna still ships none of it; what it gives you is the
plane separation that makes two clean realms the path of least resistance.

| | Operator realm | Tenant realm |
|---|---|---|
| Model | `BackofficeUser` on `BackofficeBaseModel` | `User` on `TenantBaseModel` |
| Schema | `backoffice` (pinned search path) | `tenant_<uuid>` (adapter-routed per request) |
| Guard | `backoffice` | `tenant` |
| Login | `router.central()` route | inside a tenant-guarded group |
| Gate | fail-closed admin mount | `authorizeTenantAccess` membership check |

Declare both guards in one `config/auth.ts`. The example uses access tokens;
the [session guard](#session-guard-alternative) works the same way.

```ts
// config/auth.ts
import { defineConfig } from '@adonisjs/auth'
import { tokensGuard, tokensUserProvider } from '@adonisjs/auth/access_tokens'
import type { InferAuthenticators, InferAuthEvents, Authenticators } from '@adonisjs/auth/types'

const authConfig = defineConfig({
  default: 'tenant',
  guards: {
    backoffice: tokensGuard({
      provider: tokensUserProvider({
        tokens: 'accessTokens',
        model: () => import('#models/backoffice_user'),
      }),
    }),
    tenant: tokensGuard({
      provider: tokensUserProvider({
        tokens: 'accessTokens',
        model: () => import('#models/user'),
      }),
    }),
  },
})

export default authConfig

declare module '@adonisjs/auth/types' {
  export interface Authenticators extends InferAuthenticators<typeof authConfig> {}
}
declare module '@adonisjs/core/types' {
  interface EventsList extends InferAuthEvents<Authenticators> {}
}
```

Nothing in this file mentions a schema. Each guard routes to the right place
because of the model it points at: the package installs an adapter on every
base model at boot, and `DbAccessTokensProvider` resolves its token table
through that same adapter. Operator tokens land in
`backoffice.auth_access_tokens`; tenant tokens land in each tenant's own
`auth_access_tokens`.

### The operator realm

Operators get their own model on `BackofficeBaseModel` and log in on the
apex, never inside a tenant context:

```ts
// start/routes.ts
router.central(() => {
  router.post('/backoffice/login', [BackofficeAuthController, 'login'])
})
```

`router.central()` (see [Routing](/guides/routing)) refuses requests that
carry a tenant id, so the operator login cannot be reached through a tenant
host or header. The same guard then fronts the admin surfaces:

```ts
// start/routes.ts
multitenancyAdminRoutes({
  prefix: '/admin',
  middleware: [middleware.auth({ guards: ['backoffice'] })],
  resolveAdminActor: (ctx) => ctx.auth.use('backoffice').user?.id ?? null,
})
```

`resolveAdminActor` returns the authenticated operator's id and nothing else.
With no operator on the request it returns `null`, and actions that need an
actor (starting an impersonation, for instance) are denied instead of being
attributed to a guessable default.

<Callout type="tip" title="Harden the operator realm beyond the demo">
Operators hold fleet-wide power, so treat their realm accordingly: put MFA in
front of it (an external IdP is the usual answer), keep token lifetimes short
(<code>expiresIn: '1 day'</code> or less), apply a stricter password policy
than the tenant realm's, and <a href="/guides/rate-limiting">rate-limit the
login route</a>. Above all, never point the operator guard at the tenant user
table: a tenant-realm compromise must not escalate into an operator session.
</Callout>

### The tenant realm

Tenant users stay on `TenantBaseModel` exactly as shown
[above](#per-tenant-users), and their login route lives **inside** the
tenant-guarded group:

```ts
// start/routes.ts
router
  .group(() => {
    router.post('/auth/login', [AuthController, 'login'])
  })
  .prefix('/app')
  .use(middleware.tenantGuard())
```

By the time `verifyCredentials` runs, the tenant is resolved, so the lookup
hits `tenant_<uuid>.users` and the minted token is stored in that same
schema. That storage location is the isolation guarantee: a token minted in
tenant A does not exist in tenant B, so replaying it against another tenant
fails structurally rather than by a filter you have to remember to write.

### Wiring the membership gate

With header or path resolution, whoever sends the tenant id picks the tenant.
The [membership gate](/guides/security) is where your auth proves the caller
belongs to it, and with a tenant realm in place the check is one line:

```ts
// config/multitenancy.ts
authorizeTenantAccess: async (ctx) => {
  if (ctx.request.header('authorization')) {
    return ctx.auth.use('tenant').check()
  }
  return false // deny anonymous requests; the demo allows them for exploration
},
```

`check()` returns false for a missing, foreign, or expired token and rethrows
infrastructure errors, which the package converts to a deny, so every path
fails closed into a 403 before your controller runs. The guard instance is
memoized per request, so the later `middleware.auth({ guards: ['tenant'] })`
on the route does not pay a second token lookup. If you skip the gate with a
client-controlled strategy, the package warns at boot; silence it only with
`acknowledgeNoMembershipGate: true` after enforcing membership somewhere
else.

<Callout type="warning" title="Impersonation must pass your gate too">
An app that denies by default has to decide how an
<a href="/guides/satellites/impersonation">impersonated</a> request satisfies
the membership check, because the operator carries no tenant token. Either
order <code>ImpersonationMiddleware</code> before the tenant guard and accept
requests whose <code>ctx.impersonation</code> is bound to the resolved
tenant, or keep impersonation off tenant-user routes entirely.
</Callout>

### Session-guard alternative

Cookie-based apps swap `tokensGuard` for `sessionGuard` per realm and keep
everything else: two guards, two models, the same membership wiring, and the
same ordering rule (tenant resolution first, then auth). Sessions are scoped
per tenant through the [session bootstrapper](/guides/bootstrappers/session),
which gives each tenant its own cookie namespace.

<Callout type="note" title="Prune expired tokens yourself">
<code>DbAccessTokensProvider</code> rejects expired tokens but never deletes
them, so schedule a cleanup (a nightly <code>DELETE FROM auth_access_tokens
WHERE expires_at &lt; now()</code> per schema, or a maintenance job) to keep
the token tables from growing unbounded.
</Callout>

The demo app at
[`examples/api`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/tree/master/examples/api)
implements the full picture end to end: both realms, the seeding commands,
and the e2e specs that pin every isolation property described above.

## Admin API authentication

The [Admin REST API](/guides/satellites/admin-rest-api) is **fail-closed**: it refuses to
mount without an auth middleware you provide, and it asks for a
`resolveAdminActor` callback so every privileged action is attributed to a real
operator in the audit log. The package never assumes who your admins are; you
wire the guard, it records the actor.

## Impersonation

When an operator needs to act *as* a tenant user (to reproduce a bug, for
example), use the [impersonation satellite](/guides/satellites/impersonation)
rather than sharing credentials. Impersonation tokens are time-boxed,
single-use, HMAC-signed, bound to the target tenant, and fully audited.

## Read next

- [Models](/guides/models); which base class each kind of user belongs to.
- [Routing](/guides/routing); `tenant()` vs `central()` routes for your auth endpoints.
- [Security](/guides/security); the membership gate and the production hardening checklist.
- [Impersonation](/guides/satellites/impersonation); operators entering a tenant safely.
- [Tenant identification](/guides/tenant-identification); how the tenant is resolved per request.
