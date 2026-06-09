---
title: Drive bootstrapper
description: Per-tenant filesystem prefix. Every put/get/delete is scoped to tenants/<id>/.
---

# Drive bootstrapper

Auto-detected when `@adonisjs/drive` is installed. Prefixes every
filesystem operation with `tenants/<tenant.id>/` so two tenants
cannot read each other's files even if a path is hard-coded by
mistake.

## What it does

```ts
await drive.use().put('logo.png', buf)
// Actually writes to: tenants/<active-tenant-id>/logo.png
```

Applies to every disk you've configured (`local`, `s3`, `gcs`,
…). The bootstrapper wraps the disk facade rather than each disk
individually.

## Listing

`drive.list()` returns paths *relative to the tenant prefix* by
default. Pass `{ raw: true }` to read the global path.

## Public URLs

URL signing respects the prefix automatically. Lasagna does not
fight the disk's signing implementation; it just asks the disk for
a URL using the prefixed key.

## Configuration

```ts
// config/multitenancy.ts
export default defineConfig({
  drive: {
    enabled: true, // auto-detected; force-disable with false
    prefix: 'tenants/{id}/', // {id} placeholder; default shown
  },
})
```

## Cleanup on tenant destroy

The drive bootstrapper does *not* automatically delete a tenant's
files when the tenant is destroyed. Wire that up via the
`TenantSoftDeleted` event or a hook in your provider:

```ts
import { Hook } from '@adonisjs-lasagna/saas-tenancy/events'

hookRegistry.on('tenant.soft_deleted', async ({ tenant }) => {
  await drive.use().deleteAll(`tenants/${tenant.id}/`)
})
```


## Read next

- [Bootstrappers](/docs/bootstrappers/); the rest of the per-tenant services.
- [Configuration](/docs/configuration); the drive options.
