---
title: Quickstart
description: From npm install to a live tenant in five minutes.
---

# Quickstart

The fastest path from `npm install` to a live, schema-isolated tenant.
The configure command does most of the wiring; you fill in your database
connections and one repository binding. Target: under ten minutes.

<Terminal src="/casts/quickstart.cast.json" />

::: tip Prerequisites
A running **PostgreSQL 14+** and **Redis 6+**, plus an AdonisJS 7 app on
**Node 24+**. Want the exhaustive reference (every `configure` flag,
middleware registration, requirements)? See
[Installation & configuration](/start/installation).
:::

## 1. Install

```bash
npm install @adonisjs-lasagna/saas-tenancy
node ace configure @adonisjs-lasagna/saas-tenancy --with=audit,webhooks
```

## 2. Database connections

```ts
// config/database.ts
export default defineConfig({
  connections: {
    public: { client: 'pg', connection: { ...baseConn, searchPath: 'public' } },
    backoffice: { client: 'pg', connection: { ...baseConn, searchPath: 'backoffice' } },
    // tenant_<uuid> connections register at runtime.
  },
})
```

## 3. Bootstrap the backoffice

```bash
node ace backoffice:setup
```

## 4. Bind the tenant repository

```ts
// providers/app_provider.ts
import { TENANT_REPOSITORY } from '@adonisjs-lasagna/saas-tenancy'

export default class AppProvider {
  async boot() {
    this.app.container.singleton(TENANT_REPOSITORY, async () => {
      const { default: Tenant } = await import('#models/backoffice/tenant')
      return {
        findById: (id) => Tenant.query().whereNull('deleted_at').where('id', id).first(),
        findByDomain: (host) => Tenant.query().whereNull('deleted_at').where('custom_domain', host).first(),
        all: (filters = {}) => {
          const q = Tenant.query().whereNull('deleted_at')
          if (filters.status) q.where('status', filters.status)
          return q
        },
      }
    })
  }
}
```

## 5. Create your first tenant

```bash
node ace tenant:create "Acme Corp" "admin@acme.example.com"
node ace queue:work    # in another terminal — provisions the schema
```

Once the `InstallTenant` job finishes, the row flips to `status:
'active'` and tenant-scoped routes light up.

## 6. Use `request.tenant()`

```ts
async show({ request }: HttpContext) {
  const tenant = await request.tenant()
  // Memoised per request, same reference no matter how many times you call it.
}
```

## 7. Secure your tenants

The guard verifies the resolved tenant exists and is active, but resolution is
trust-the-input, so it does **not** check that the caller belongs to that tenant.
Add one line so a user of tenant A can't read tenant B by swapping `x-tenant-id`:

```ts
// config/multitenancy.ts: reject callers who don't belong to the resolved tenant
authorizeTenantAccess: (ctx, tenant) => ctx.auth?.user?.tenantId === tenant.id
```

Return `false` (or throw) to deny with a 403. This is a membership check, not full
RBAC; for users in several tenants, look the pair up in your membership table. See
[Security › What the host owns](/guides/security#what-the-host-owns) for the rationale
and the multi-tenant variant.

## 8. Verify it worked

```bash
node ace tenant:doctor
```

`doctor` checks your connections, schema health, and configuration. A green
report means the tenant is provisioned and routable. Wire it into CI so a
broken tenant fails the build instead of production.

## What's next?

Follow the path in order, or jump to whichever step you need:

- [Concepts](/start/concepts); the four-layer mental model behind what you just wired.
- [Tenant identification](/guides/tenant-identification); pick the resolver strategy
  that fits how your tenants reach the app.
- [Models & adapters](/guides/models); define your first tenant-scoped model and watch
  queries route themselves, no `where('tenant_id', …)` in sight. This is where you
  start building features.
- [Installation](/start/installation); the exhaustive reference for when you need a
  flag, a middleware, or a connection option this quickstart skipped.
- [Doctor](/reference/commands#doctor); wire `tenant:doctor` into CI before you ship.

::: info Reference app
The full feature surface lives in
[examples/api](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/tree/master/examples/api),
a real AdonisJS 7 app with an end-to-end suite of 120+ tests across the
feature surface.
:::
