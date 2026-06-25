---
title: Models
description: How to write models against the three base classes and the row-scope mixin, what schema each one hits, cross-layer rules, and how querying behaves inside and outside a tenant context.
---

# Models

[Concepts](/start/concepts) introduced the four layers. This page is the hands-on
reference: which base class to extend, what each one does at runtime, and how queries
behave with and without an active tenant.

There are three base classes plus one mixin. The base class (or mixin) you extend is the
single thing that decides which schema a query lands in.

| You extend | Lands in | Use it for |
|---|---|---|
| `TenantBaseModel` | the active tenant's schema/database | per-customer data, with the `schema-pg` or `database-pg` driver |
| `withTenantScope(BaseModel)` | a shared schema, filtered by `tenant_id` | per-customer data, with the `rowscope-pg` driver |
| `BackofficeBaseModel` | the shared `backoffice` schema | the tenant registry and operator/satellite data |
| `CentralBaseModel` | the `public` (central) schema | cross-tenant, product-wide data |

Import the base classes from the package root, and the row-scope mixin from there too:

```ts
import {
  TenantBaseModel,
  BackofficeBaseModel,
  CentralBaseModel,
  withTenantScope,
  unscoped,
} from '@adonisjs-lasagna/saas-tenancy'
```

## TenantBaseModel

`TenantBaseModel` is a plain Lucid `BaseModel`. It declares no connection of its own.
At query time the `TenantAdapter` reads the active tenant and routes the connection to
that tenant's `tenant_<uuid>` schema (`schema-pg`) or per-tenant database (`database-pg`).
Because the whole connection is tenant-scoped, **your model needs no `tenant_id` column**
and no manual filtering.

```ts
// app/models/invoice.ts
import { column } from '@adonisjs/lucid/orm'
import { TenantBaseModel } from '@adonisjs-lasagna/saas-tenancy'
import { DateTime } from 'luxon'

export default class Invoice extends TenantBaseModel {
  @column({ isPrimary: true }) declare id: number
  @column() declare number: string
  @column() declare amountCents: number
  @column.dateTime({ autoCreate: true }) declare createdAt: DateTime
}
```

Its migration lives in the tenant migrations folder
(`database/migrations/tenant/`, the path `tenant:migrate` runs against). It is an
ordinary Lucid migration; the driver applies it inside *each* tenant's schema, so
it carries no `tenant_id` column:

```ts
// database/migrations/tenant/0001_create_invoices.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.createTable('invoices', (table) => {
      table.increments('id')
      table.string('number').notNullable()
      table.integer('amount_cents').notNullable()
      table.timestamp('created_at')
    })
  }

  async down() {
    this.schema.dropTable('invoices')
  }
}
```

Apply it across every tenant schema with `node ace tenant:migrate`. From there a
controller queries the model with nothing tenant-specific in the call:

```ts
// Inside an HTTP request the active tenant comes from the guard; just query.
const invoices = await Invoice.all()

// Outside a request (jobs, commands, scripts) open a context first:
await tenancy.run(tenant, async () => {
  await Invoice.create({ number: 'INV-1', amountCents: 5000 })
})
```

A `TenantBaseModel` query with no active tenant context (no HTTP guard, no
`tenancy.run(...)`) cannot resolve a connection and fails fast. That is intentional: a
silent fallback to a default connection would be a cross-tenant leak. See
[querying outside a tenant context](#querying-outside-a-tenant-context).

## Row-scoped models (rowscope-pg)

The `rowscope-pg` driver keeps every tenant in one shared schema and isolates by a
`tenant_id` column. Models opt in with the `withTenantScope(BaseModel)` mixin instead of
extending `TenantBaseModel`. The mixin injects `where tenant_id = <current>` into reads,
auto-fills the column on create, and refuses writes that target another tenant's id.

```ts
import { BaseModel, column } from '@adonisjs/lucid/orm'
import { withTenantScope } from '@adonisjs-lasagna/saas-tenancy'

export default class Note extends withTenantScope(BaseModel) {
  @column({ isPrimary: true }) declare id: number
  @column() declare body: string
  // tenant_id is managed by the mixin; you still add the migration column.
}
```

::: warning A top-level `orWhere` can escape the auto-scope
The scope is injected as flat predicates, and SQL binds `AND` tighter than `OR`, so a
non-grouped top-level `orWhere` can leave a branch unfiltered and leak rows across
tenants. Always group `OR` branches: `Note.query().where((q) => q.where(...).orWhere(...))`.
For a database-enforced boundary that does not depend on query-author discipline, enable
Row-Level Security: publish the policy with `configure --with=rls` and set the tenant per
transaction with `withTenantRls()`. Full detail in [rowscope-pg](/guides/data-isolation/rowscope-pg).
:::

In strict mode (the default, `config.isolation.rowScopeMode = 'strict'`) a scoped query
with no active context and no `unscoped(...)` wrapper throws rather than running an
unscoped global query. That turns a forgotten `tenancy.run(...)` into a loud failure
instead of a leak.

## BackofficeBaseModel

`BackofficeBaseModel` pins `static connection = 'backoffice'`, so it always reads and
writes the shared `backoffice` schema regardless of the active tenant. This is where the
tenant registry lives, and where the satellites store their cross-tenant data (audit logs,
feature flags, webhooks, branding, metrics).

```ts
import { column } from '@adonisjs/lucid/orm'
import { BackofficeBaseModel } from '@adonisjs-lasagna/saas-tenancy'

export default class Tenant extends BackofficeBaseModel {
  @column({ isPrimary: true }) declare id: string
  @column() declare name: string
  @column() declare status: string
}
```

The host app owns the `Tenant` model and binds a `TenantRepositoryContract` for it; the
package never imports it directly. See [Installation](/start/installation).

## CentralBaseModel

`CentralBaseModel` pins `static connection = 'public'` and prefixes its table name with
the configured `centralSchemaName`. Use it for data that belongs to your product as a
whole rather than to any tenant: plan catalogs, country lists, anything global.

```ts
import { column } from '@adonisjs/lucid/orm'
import { CentralBaseModel } from '@adonisjs-lasagna/saas-tenancy'

export default class Plan extends CentralBaseModel {
  @column({ isPrimary: true }) declare id: number
  @column() declare code: string
  @column() declare priceCents: number
}
```

## Cross-layer relationships

Lucid relationships resolve on a single connection, and the three layers live on different
schemas (and, with `database-pg`, different databases). So a Lucid `belongsTo` /
`hasMany` that crosses layers will not resolve, and a foreign key cannot span a per-tenant
schema and the central schema.

Model relationships **within** a layer work normally (a `TenantBaseModel` relating to another
`TenantBaseModel`, both in the tenant schema). To associate **across** layers, store the
other layer's id as a plain column and load it explicitly:

```ts
// In a tenant-schema model, reference a central Plan by id, not by relation.
@column() declare planId: number

// Load it on the central connection when you need it:
const plan = await Plan.find(invoice.planId)
```

## Querying outside a tenant context

Inside an HTTP request the tenant guard establishes the context, so models just work.
Outside a request, or to step outside the active tenant deliberately, there are two tools:

- `tenancy.run(tenant, fn)` opens a tenant context for `fn`. Jobs, commands, and scripts
  that touch `TenantBaseModel` or row-scoped models must wrap their work in it.
- `unscoped(fn)` disables row-scoping for `fn`. Use it for legitimate cross-tenant work
  (admin reports, central migrations, audit emission). It applies to the `rowscope-pg`
  mixin; prefer scoped queries everywhere in user-facing code paths.

```ts
import { tenancy, unscoped } from '@adonisjs-lasagna/saas-tenancy'

// Tenant-scoped work from a job:
await tenancy.run(tenant, () => Invoice.create({ number: 'INV-2', amountCents: 900 }))

// Deliberate cross-tenant read on a row-scoped model:
const allNotes = await unscoped(() => Note.all())
```

## Lifecycle hooks

The base classes are ordinary Lucid models, so the standard Lucid decorators
(`@beforeSave`, `@afterCreate`, and so on) work as usual. The row-scope mixin registers its
own `before('create'|'update'|'delete'|'find'|'fetch'|'paginate')` hooks to manage the
`tenant_id` column; your hooks compose with them. For tenant **lifecycle** events
(provision, migrate, suspend, delete) reach for the package's
[lifecycle events and hooks](/reference/events) rather than per-model hooks.

## Read next

- [Data isolation](/guides/data-isolation/) for the driver each base class pairs with.
- [Tenant identification](/guides/tenant-identification) for how the active tenant is resolved.
- [rowscope-pg](/guides/data-isolation/rowscope-pg) for the shared-schema model in depth.
