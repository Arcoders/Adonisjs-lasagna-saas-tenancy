---
title: Drive bootstrapper
description: Per-tenant filesystem prefix via tenantDisk(). Keyed operations are scoped to tenants/<id>/.
---

# Drive bootstrapper

Auto-detected when `@adonisjs/drive` is installed. It validates the
tenant id at scope entry (the id becomes a real path component, so a
malformed one must never reach the disk) and gives you `tenantDisk()`,
a disk handle whose keyed operations are prefixed with
`tenants/<tenant.id>/` so two tenants cannot read each other's files.

## What it does

```ts
import { tenantDisk } from '@adonisjs-lasagna/saas-tenancy/services'

const disk = await tenantDisk()
await disk.put('logo.png', buf)
// Actually writes to: tenants/<active-tenant-id>/logo.png

const s3 = await tenantDisk('s3')
await s3.get('reports/q1.csv')
// Reads from: tenants/<active-tenant-id>/reports/q1.csv
```

The helper works for every disk you've configured (`local`, `s3`,
`gcs`, …); pass the disk name. It throws outside a `tenancy.run()`
scope (or an HTTP request that resolved a tenant).

The scoping is explicit, not interception: a direct
`drive.use().put('logo.png', buf)` writes to the *global* `logo.png`.
Reach for `tenantDisk()` (or build keys with `tenantPrefix()`)
anywhere tenant files are involved.

## What gets prefixed

The keyed methods (`get`, `getStream`, `getUrl`, `getSignedUrl`,
`put`, `putStream`, `delete`, `deleteAll`, `copy`, `move`, `exists`,
`list`, and friends) have their key argument(s) prefixed. Everything
else forwards to the disk untouched, so URL signing works on the
prefixed key automatically.

Note that `list()` results carry the full backend keys (including the
`tenants/<id>/` prefix); strip `tenantPrefix()` yourself if you need
tenant-relative paths.

## Cleanup on tenant destroy

The drive bootstrapper does *not* automatically delete a tenant's
files when the tenant is destroyed. Wire that up with a lifecycle
hook:

```ts
// config/multitenancy.ts
export default defineConfig({
  hooks: {
    afterDestroy: async ({ tenant }) => {
      const drive = (await import('@adonisjs/drive/services/main')).default
      await drive.use().deleteAll(`tenants/${tenant.id}/`)
    },
  },
})
```

## Read next

- [Bootstrappers](/docs/bootstrappers/); the rest of the per-tenant services.
- [Hooks](/docs/hooks); the lifecycle callbacks used for cleanup.
