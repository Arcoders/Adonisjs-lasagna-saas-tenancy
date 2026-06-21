---
title: Routing
description: Central routes vs tenant routes vs universal routes. The router.tenant() / router.central() / router.universal() macros and where to register middleware.
---

# Routing

<Callout type="tip" title="Three explicit groups">
Lasagna installs three route-group macros on the AdonisJS router:
<code>router.tenant()</code>, <code>router.central()</code>, and
<code>router.universal()</code>. Each one wraps its block in the
right middleware so route declarations stay declarative.
</Callout>

## The three macros

Installed by the multitenancy provider on app boot. Idempotent.

| Macro | Wraps with | Use for |
|---|---|---|
| `router.tenant(cb)` | `TenantGuardMiddleware` | Routes that REQUIRE a resolved tenant. Throws if missing, suspended, or not-ready. |
| `router.central(cb)` | `CentralOnlyMiddleware` | Routes that REQUIRE no tenant in scope. Signup, marketing, central admin. |
| `router.universal(cb)` | `UniversalMiddleware` | Routes that work in both contexts. Resolves the tenant when present, never fails when absent. |

```ts
// start/routes.ts
import router from '@adonisjs/core/services/router'

// Tenant-only: every route here goes through TenantGuardMiddleware
router.tenant(() => {
  router.get('/api/users', '#controllers/users.index')
  router.post('/api/orders', '#controllers/orders.create')
})

// Central-only: tenant context must be absent
router.central(() => {
  router.get('/signup', '#controllers/onboarding.signup')
  router.post('/signup', '#controllers/onboarding.create_tenant')
})

// Universal: works either way (login page, status endpoint)
router.universal(() => {
  router.get('/health', '#controllers/health.show')
  router.get('/login', '#controllers/auth.login')
})
```

The macros return the underlying `RouteGroup` so you can chain
`.prefix()`, `.use()`, `.where()`, etc.

## Custom domain mapping

Custom domains (e.g. `acme.com` resolving to a tenant) are wired up
by `CustomDomainMiddleware`, registered as a server middleware so it
runs before route matching:

```ts
// start/kernel.ts
server.use([
  () => import('@adonisjs-lasagna/saas-tenancy/middleware')
    .then((m) => ({ default: m.CustomDomainMiddleware })),
])
```

The middleware queries your tenant repository's `findByDomain(host)`
and rewrites the request to the canonical tenant header before
`router.tenant()` / `router.universal()` blocks resolve.

### Strict mode (the default)

The middleware is **secure by default**: the verified `Host`-resolved
custom domain is authoritative. When both a matching `Host` and an
`x-tenant-id` header are present and they disagree, the request is
rejected with HTTP 400 (`E_TENANT_HEADER_DOMAIN_MISMATCH`) before any
handler runs, closing the tenant-hop vector where a caller who knows
your custom domain shapes a request for a different tenant.

```ts
// start/kernel.ts
server.use([
  () => import('@adonisjs-lasagna/saas-tenancy/middleware')
    .then((m) => ({ default: m.CustomDomainMiddleware })),
])
// Attach via a named middleware — strict is the default, no option needed:
//   middleware.customDomain()
```

Opt **out** only if you intentionally route by header on hosts the
package also manages as custom domains (the pre-1.0 behavior):
`middleware.customDomain({ strict: false })`. Understand the trade-off:
any caller able to set the header can then address a different tenant
through a verified domain.

When both `Host` matches a registered custom domain AND
`x-tenant-id` is present:

| Mode | Header agrees | Header disagrees | Header only (no domain match) |
|---|---|---|---|
| **Default (strict)** | header agrees, allow | **reject 400** | header wins |
| `strict: false` (opt-in) | header wins | header wins (vector!) | header wins |

## Imperative API

For non-HTTP code (queue jobs, scripts, ace commands), there is no
route. Wrap the work in `tenancy.run()`:

```ts
import { tenancy } from '@adonisjs-lasagna/saas-tenancy/services'

await tenancy.run(tenant, async () => {
  // any package code that reads tenancy.currentId() sees tenant.id.
})
```

This activates the bootstrapper registry around `fn`. The bundled
`InstallTenant` and `UninstallTenant` jobs already do this. Your
custom jobs should too.

## Reverse routing

```ts
// Generate a per-tenant URL
const url = router.makeUrl('orders.show', { id: orderId }, {
  prefixUrl: tenant.customDomain
    ? `https://${tenant.customDomain}`
    : `https://${tenant.id}.app.example.com`,
})
```

## When to use which

| Scenario | Use |
|---|---|
| HTTP request requiring a tenant | `router.tenant(() => …)` |
| HTTP request that must NOT have a tenant | `router.central(() => …)` |
| HTTP request that adapts when a tenant is present | `router.universal(() => …)` |
| Background job | `tenancy.run(tenant, fn)` inside the handler |
| Ace command iterating tenants | `tenant:exec <command>` (does the wrap for you) |
| Test setup | `setRequestTenant(tenant)` from `/testing` |

## Read next

- [Testing](/docs/testing). `setRequestTenant` and the testing
  bootstrappers.
- [Cookbook, custom-domain HTTPS](/docs/cookbook/custom-domain-https).
  Wildcard cert plus DNS-01 plus Cloudflare-style flow.
