---
title: Quickstart
description: From npm install to a live tenant in five minutes.
---

# Quickstart

From `npm install` to a live tenant in five minutes. The configure
command does most of the wiring; you only fill in connections and
the repository binding.

<Terminal src="/casts/quickstart.cast.json" />

::: tip Already installed?
Skip to the [installation guide](/docs/installation) for the
canonical step-by-step. This page is the marketing-friendly tour.
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

## What's next?

- [Installation](/docs/installation); the full step-by-step.
- [Concepts](/docs/concepts); the four-layer mental model.
- [Tenant identification](/docs/tenant-identification); pick a
  resolver strategy.
- [Doctor](/docs/commands#doctor); wire `tenant:doctor` into CI
  before you ship.

::: info Reference app
The full feature surface lives in
[examples/api](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/tree/master/examples/api)
by a real AdonisJS 7 app with a 123-test e2e suite.
:::
