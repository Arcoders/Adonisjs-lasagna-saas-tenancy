---
title: Installation & configuration
description: The complete reference — requirements matrix, the configure command and its flags, database connections, middleware, and the tenant repository binding.
---

# Installation & configuration

This is the complete reference. For the fastest path to a running tenant, the
[Quickstart](/quickstart) gets you there in under ten minutes; come back here
for every `configure` flag, the middleware wiring, and the requirements matrix.

<Callout type="tip" title="Five steps">
<code>npm install</code> → <code>configure</code> → wire connections
→ run <code>backoffice:setup</code> → bind your tenant repository.
The configure command does most of the wiring; you only fill in the
connection details and the <code>TENANT_REPOSITORY</code> binding.
</Callout>

## Requirements

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | ≥ 24 | ES modules, `module: NodeNext` |
| AdonisJS | 7 | |
| PostgreSQL | ≥ 14 | via `@adonisjs/lucid` |
| Redis | ≥ 6 (≥ 6.2 with the SSO satellite — its state consumption uses `GETDEL`) | via `@adonisjs/redis` — cache + counters |
| `@adonisjs/queue` | required | background jobs provision schemas |
| `@aws-sdk/client-s3` | optional | only for S3 backup uploads |
| `jose` | optional | only when SSO is enabled |

## 1. Install and configure

```bash
npm install @adonisjs-lasagna/saas-tenancy
node ace configure @adonisjs-lasagna/saas-tenancy
```

The configure command does three things:

1. Registers `MultitenancyProvider` in `adonisrc.ts`.
2. Publishes `config/multitenancy.ts` from a typed `defineConfig({...})` stub.
3. Scaffolds `app/models/backoffice/tenant.ts`.

By default it also publishes migration stubs for **every satellite**
(audit, feature_flags, webhooks, branding, sso, metrics). You usually
want to be selective:

```bash
# Only audit logs and webhooks
node ace configure @adonisjs-lasagna/saas-tenancy --with=audit,webhooks

# Interactive (prompts you with a checkbox list)
node ace configure @adonisjs-lasagna/saas-tenancy

# CI-friendly: explicit list, no prompt
node ace configure @adonisjs-lasagna/saas-tenancy --no-interaction --with=audit,branding,feature_flags
```

## 2. Set up your database connections

Three connection contexts live side by side. Add them to
`config/database.ts`:

```ts
// config/database.ts
export default defineConfig({
  connections: {
    public: {
      client: 'pg',
      connection: { ...baseConn, searchPath: 'public' },
    },
    backoffice: {
      client: 'pg',
      connection: { ...baseConn, searchPath: 'backoffice' },
    },
    // Tenant connections are created at runtime, no entry needed here.
  },
})
```

| Connection      | Schema           | Purpose                                  |
| --------------- | ---------------- | ---------------------------------------- |
| `public`        | `public`         | Shared global data                       |
| `backoffice`    | `backoffice`     | Tenant registry + satellite features     |
| `tenant_<uuid>` | `tenant_<uuid>`  | Per-tenant data, created on demand       |

::: tip Why three connections?
Three lifecycles, three schemas. Data owned by **your app**
(`public`), data owned by **your operators** (`backoffice`), and data
owned by **individual customers** (per-tenant). Mixing them
eventually bites; tenant exports leak admin rows, backups balloon,
migrations target the wrong schema.
:::

## 3. Bootstrap the backoffice

```bash
node ace backoffice:setup
```

Creates the `backoffice` schema and runs all satellite-table
migrations in one shot. Idempotent; re-run any time.

## 4. Bind the tenant repository

The package never imports your `Tenant` model; it asks the IoC
container for a `TenantRepositoryContract`. Wire it once in your app
provider:

```ts
// providers/app_provider.ts
import { TENANT_REPOSITORY } from '@adonisjs-lasagna/saas-tenancy'

export default class AppProvider {
  async boot() {
    this.app.container.singleton(TENANT_REPOSITORY, async () => {
      const { default: Tenant } = await import('#models/backoffice/tenant')
      return {
        findById: (id) =>
          Tenant.query().whereNull('deleted_at').where('id', id).first(),

        findByDomain: (host) =>
          Tenant.query().whereNull('deleted_at').where('custom_domain', host).first(),

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

## 5. Register middleware

```ts
// start/kernel.ts

router.use([
  () => import('@adonisjs-lasagna/saas-tenancy/middleware')
    .then(m => ({ default: m.TenantGuardMiddleware })),
])

server.use([
  () => import('@adonisjs-lasagna/saas-tenancy/middleware')
    .then(m => ({ default: m.CustomDomainMiddleware })),
])

router.use([
  () => import('@adonisjs-lasagna/saas-tenancy/middleware')
    .then(m => ({ default: m.RateLimitMiddleware })),
])
```

`RateLimitMiddleware` is **fail-closed** by default: if the Redis
backend is unreachable, the middleware throws
`RateLimitUnavailableException` (HTTP 503) rather than silently
letting traffic through. Opt into the legacy fail-open behaviour
on a per-route basis only if you'd rather risk abuse than degraded
availability:

```ts
// per-route options
.use(middleware.rateLimit({ limit: 100, windowSeconds: 60, failOpen: true }))
```

The middleware also short-circuits when `app.inTest === true`, so
the rest of your integration suite isn't gated on Redis. Tests that
target the rate-limit codepath itself must opt in with
`bypassInTestEnv: true`.

## 6. Create your first tenant

```bash
node ace tenant:create "Acme Corp" "admin@acme.example.com"
node ace queue:work       # in another terminal, runs the InstallTenant job
node ace tenant:migrate   # apply your tenant migrations into the new schema
```

Provisioning and migrating are separate steps. The `InstallTenant` job
creates the tenant's schema (or database) and flips the row to `status:
'active'`, but the schema starts **empty**. Run `tenant:migrate` to apply
your `database/migrations/tenant` files into it; only then do tenant-scoped
routes have tables to query.

Prefer to migrate automatically on provision? Wire the `afterProvision`
hook to `driver.migrate(tenant, { direction: 'up' })` in
`config/multitenancy.ts`. See [Hooks](/docs/hooks).

## Read next

- [Tenant identification](/docs/tenant-identification); pick a
  resolver strategy.
- [Data isolation](/docs/data-isolation/); choose between
  schema-per-tenant, database-per-tenant, and row scoping.
- [Routing](/docs/routing). The `router.tenant()`,
  `router.central()`, and `router.universal()` macros plus custom
  domain mapping.
