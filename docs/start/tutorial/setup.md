---
title: 'Tutorial 1: Setup'
description: Install Lasagna, wire the three database connections, bootstrap the backoffice schema, and bind your tenant repository — the foundation the rest of the tutorial builds on.
---

# Step 1: Setup

You'll install the package, wire the three connections every Lasagna app uses, bootstrap
the shared `backoffice` schema, and bind the one piece of glue the package needs from you:
a tenant repository. At the end you'll have an app that boots clean and passes `tenant:doctor`.

This step is the tutorial-paced version of [Installation](/start/installation). That page
is the exhaustive reference (every `configure` flag, the requirements matrix); here we make
just the choices Helpdesk needs and move on.

## 1. Install and configure

```bash
npm install @adonisjs-lasagna/saas-tenancy
node ace configure @adonisjs-lasagna/saas-tenancy --with=quotas,metrics
```

The `configure` command registers `MultitenancyProvider`, publishes a typed
`config/multitenancy.ts`, and scaffolds `app/models/backoffice/tenant.ts`. We pass
`--with=quotas,metrics` because step 4 needs the `tenant_plans` table and step 5 needs the
metrics tables (`tenant_metrics`, `tenant_custom_metrics`, `tenant_metrics_monthly`); the
billing and reporting satellites get installed in their own steps. Everything else is left
at its defaults.

## 2. Wire three connections

Helpdesk routes queries across three Postgres schemas, so `config/database.ts` declares
three connection contexts:

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
    // tenant_<uuid> connections register themselves at runtime — no entry here.
  },
})
```

| Connection | Schema | Owns |
|---|---|---|
| `public` | `public` | Product-wide data (plan catalog, country lists) |
| `backoffice` | `backoffice` | The tenant registry and satellite tables |
| `tenant_<uuid>` | `tenant_<uuid>` | One customer's data, created on demand |

Three lifecycles, three schemas. Keeping them apart is what makes a tenant export, a
backup, or a `DROP SCHEMA` affect exactly one customer and nothing else.

## 3. Bootstrap the backoffice

```bash
node ace backoffice:setup
```

This creates the `backoffice` schema and runs its migrations in one shot: the `tenants`
table, then every satellite migration you published (here, `tenant_plans`). It's
idempotent, so re-run it any time you add a satellite.

## 4. Meet the tenant repository

The package never imports your `Tenant` model. Instead it asks the container for a
`TenantRepositoryContract`. `configure` already wrote both halves of that glue, so open
them and read:

```ts
// app/repositories/tenant_repository.ts
export default class TenantRepository implements TenantRepositoryContract {
  async findById(id: string, includeDeleted = false) {
    const query = Tenant.query().where('id', id)
    if (!includeDeleted) query.whereNull('deleted_at')
    return query.first()
  }
  // …findByIdOrFail, findByDomain, all, whereIn, each, create, countByStatus
}
```

```ts
// providers/tenancy_provider.ts
register() {
  this.app.container.bind(TENANT_REPOSITORY as any, () => new TenantRepository())
}
```

The scaffolded `Tenant` model extends `BackofficeBaseModel`, so it always reads the shared
`backoffice` schema regardless of which tenant is active. You own this model and can add
columns to it freely; the package only ever touches it through the repository.

## 5. Register the tenant guard

`TenantGuardMiddleware` resolves the active tenant on every request and verifies it exists
and is active. Register it as router middleware:

```ts
// start/kernel.ts
router.use([
  () =>
    import('@adonisjs-lasagna/saas-tenancy/middleware').then((m) => ({
      default: m.TenantGuardMiddleware,
    })),
])
```

<Callout type="note" title="Order matters later">
The tenant guard must run <strong>before</strong> any auth middleware, because a per-tenant
user lookup needs the active tenant already resolved. You'll wire auth in
<a href="/start/tutorial/users">step 3</a>; keep the guard first when you do.
</Callout>

## 6. Verify it boots

```bash
node ace tenant:doctor
```

`doctor` checks your connections, schema health, and configuration. With no tenants yet
it should report the backoffice as healthy and your config as valid. A green report means
the foundation is solid. Wire this into CI so a broken connection fails the build instead
of production.

## Read next

- [Step 2: Tenants](/start/tutorial/tenants); create your first tenant and its first model.
- [Installation](/start/installation); the exhaustive reference for any flag this step skipped.
- [Concepts](/start/concepts); the four-layer model behind the three connections.
