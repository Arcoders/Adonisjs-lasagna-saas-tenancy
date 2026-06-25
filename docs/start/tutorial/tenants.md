---
title: 'Tutorial 2: Tenants'
description: Create and provision your first tenant, define a tenant-scoped Ticket model, migrate it into every tenant schema, and query it with zero tenant_id plumbing.
---

# Step 2: Tenants

Now you'll bring a tenant to life. You'll create one, watch the background job provision
its private schema, then add Helpdesk's first piece of customer data, a `Ticket` model,
and migrate it into that schema. By the end a controller can read and write tickets
without ever naming a tenant.

## 1. Create a tenant

```bash
node ace tenant:create "Acme Corp" "admin@acme.example.com"
```

This inserts a row into the backoffice `tenants` table with `status: 'provisioning'` and
enqueues an `InstallTenant` job. Creation and provisioning are separate on purpose:
the row exists immediately, but the schema is built off the request path so a slow
provision never blocks an API call.

Run a worker to drain the job:

```bash
node ace queue:work
```

When `InstallTenant` finishes it creates the `tenant_<uuid>` schema and flips the row to
`status: 'active'`. Only an active tenant resolves through the guard, so a half-provisioned
tenant can never serve traffic.

<Callout type="tip" title="Watch it happen">
Run <code>tenant:create</code> in one terminal and <code>queue:work</code> in another.
The worker logs the <code>InstallTenant</code> job, and a second
<code>node ace tenant:doctor</code> now reports the new schema as healthy.
</Callout>

## 2. Define a tenant-scoped model

Helpdesk's tickets belong to one customer each, so `Ticket` extends `TenantBaseModel`. That
base class declares no connection of its own; at query time the tenant adapter routes it to
the active tenant's schema. Because the whole connection is tenant-scoped, **the model needs
no `tenant_id` column and no manual filtering.**

```ts
// app/models/ticket.ts
import { column } from '@adonisjs/lucid/orm'
import { TenantBaseModel } from '@adonisjs-lasagna/saas-tenancy'
import { DateTime } from 'luxon'

export default class Ticket extends TenantBaseModel {
  @column({ isPrimary: true }) declare id: number
  @column() declare subject: string
  @column() declare status: 'open' | 'closed'
  @column.dateTime({ autoCreate: true }) declare createdAt: DateTime
}
```

Its migration lives in the **tenant** migrations folder, the path `tenant:migrate` applies
across every tenant schema. It's an ordinary Lucid migration with no `tenant_id` column,
because each tenant gets its own copy of the table:

```ts
// database/migrations/tenant/0001_create_tickets.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.createTable('tickets', (table) => {
      table.increments('id')
      table.string('subject').notNullable()
      table.string('status').notNullable().defaultTo('open')
      table.timestamp('created_at')
    })
  }

  async down() {
    this.schema.dropTable('tickets')
  }
}
```

Apply it into every tenant's schema:

```bash
node ace tenant:migrate
```

Provisioning and migrating are deliberately distinct: `InstallTenant` builds an **empty**
schema, and `tenant:migrate` fills it with your tables. To migrate automatically the moment
a tenant is provisioned, wire the `afterProvision` hook in `config/multitenancy.ts` (see
[Hooks](/reference/hooks)).

## 3. Query it, no tenant in sight

Inside an HTTP request the guard has already established the active tenant, so a controller
just queries the model:

```ts
// app/controllers/tickets_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import Ticket from '#models/ticket'

export default class TicketsController {
  async index() {
    // Routes to the calling tenant's schema automatically.
    return Ticket.query().orderBy('created_at', 'desc')
  }

  async store({ request }: HttpContext) {
    return Ticket.create({ subject: request.input('subject'), status: 'open' })
  }
}
```

`request.tenant()` is available if you need the tenant model itself (it's memoized per
request, so calling it repeatedly is free), but for a plain query you don't even reach for
it. That's the point: the schema is selected by the base class, not by your `where` clause.

## 4. Working outside a request

Jobs, commands, and scripts have no HTTP guard to set the context, so a `TenantBaseModel`
query there would have no tenant to resolve and fails fast. That's intentional, a silent
fallback would be a cross-tenant leak. Open a context explicitly with `tenancy.run`:

```ts
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'

await tenancy.run(tenant, async () => {
  await Ticket.create({ subject: 'Imported from email', status: 'open' })
})
```

## Read next

- [Step 3: Users & auth](/start/tutorial/users); give each tenant its own users.
- [Models](/guides/models); the three base classes and the row-scope mixin in depth.
- [Tenant identification](/guides/tenant-identification); how the guard resolves the tenant per request.
