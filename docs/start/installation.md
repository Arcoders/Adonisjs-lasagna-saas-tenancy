---
title: Installation & configuration
description: The complete reference; requirements matrix, the configure command and its flags, database connections, middleware, and the tenant repository binding.
---

# Installation & configuration

This is the complete reference. For the fastest path to a running tenant, the
[Quickstart](/start/quickstart) gets you there in under ten minutes; come back here
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

A bare `configure` publishes everything a working install needs, and nothing else:

1. Registers `TenancyProvider` and `MultitenancyProvider` in `adonisrc.ts`.
2. Publishes `config/multitenancy.ts` from a typed `defineConfig({...})` stub.
3. Scaffolds `app/models/backoffice/tenant.ts`,
   `app/repositories/tenant_repository.ts` and `providers/tenancy_provider.ts`.
4. Publishes the migration that creates the central `tenants` table.

Satellite features are **opt-in**. Nothing beyond the list above is published
unless you ask for it, because each feature adds a table you would then have to
maintain:

```bash
# Only audit logs and webhooks
node ace configure @adonisjs-lasagna/saas-tenancy --with=audit,webhooks

# In a terminal, a bare run prompts you with a checkbox list (nothing preselected)
node ace configure @adonisjs-lasagna/saas-tenancy

# Piped or in CI there is no prompt, so name what you want explicitly
node ace configure @adonisjs-lasagna/saas-tenancy --with=audit,branding,feature_flags
```

Every step is idempotent. Re-running `configure` skips files that already exist
and migrations already published, so your edits survive.

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

Creates the `backoffice` schema, then runs its migrations: the `tenants` table
first, then any satellite tables you opted into. Idempotent; re-run any time.

## 4. The tenant repository

The package never imports your `Tenant` model; it asks the IoC container for a
`TenantRepositoryContract`. `configure` writes both halves of that wiring, so
this step is a read, not a task.

`providers/tenancy_provider.ts` binds it:

```ts
import { TENANT_REPOSITORY } from '@adonisjs-lasagna/saas-tenancy/types'
import TenantRepository from '../app/repositories/tenant_repository.js'

export default class TenancyProvider {
  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.bind(TENANT_REPOSITORY as any, () => new TenantRepository())
  }
}
```

`app/repositories/tenant_repository.ts` implements it. Seven methods are
required, one is optional:

| Method | Used by |
| --- | --- |
| `findById(id, includeDeleted?)` | `request.tenant()`, every tenant command |
| `findByIdOrFail(id, includeDeleted?)` | Paths that must not silently no-op |
| `findByDomain(domain)` | The `domain` and `domain-or-subdomain` resolvers |
| `all({ includeDeleted?, statuses? })` | `tenant:list`, admin listings |
| `whereIn(ids, includeDeleted?)` | Bulk operations |
| `each(callback, options?)` | Cross-tenant sweeps, memory-safe on large registries |
| `create({ name, email, status })` | `tenant:create` |
| `countByStatus({ includeDeleted? })` *(optional)* | `/metrics`. Omit it and the collector falls back to `all()` |

Rewrite the queries to match your tenants table if it differs from the one the
migration created. Keep the method names: the package calls them by name, and
the contract is enforced at compile time by `implements TenantRepositoryContract`.

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

Two attribution notes when running behind a proxy or CDN:

- Buckets are keyed per tenant **and per client IP**, and the IP comes from
  `request.ip()`, which honours `X-Forwarded-For` only according to your
  app's `trustProxy` config. A misconfigured `trustProxy` lets a client mint
  unlimited fresh buckets by spoofing the header; verify it before relying on
  rate limits for abuse protection.
- The tenant part prefers the id the tenant guard already resolved
  (`tenancy.currentId()`), falling back to the synchronous resolver and then
  to a shared `global` bucket. Mount rate limiting after the tenant guard
  when you want strict per-tenant attribution under domain-based resolution.

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
`config/multitenancy.ts`. See [Hooks](/reference/hooks).

## Read next

- [Tenant identification](/guides/tenant-identification); pick a
  resolver strategy.
- [Data isolation](/guides/data-isolation/); choose between
  schema-per-tenant, database-per-tenant, and row scoping.
- [Routing](/guides/routing). The `router.tenant()`,
  `router.central()`, and `router.universal()` macros plus custom
  domain mapping.
