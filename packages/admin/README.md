# @adonisjs-lasagna/admin

Admin REST API + OpenAPI 3.1 spec + Swagger UI for
[`@adonisjs-lasagna/saas-tenancy`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy).

This package was split out of the core so the admin surface (tenant CRUD,
impersonation, satellite management) versions on its own cadence and is only
installed by apps that mount it.

## Install

```bash
npm i @adonisjs-lasagna/admin
```

It declares `@adonisjs-lasagna/saas-tenancy` as a peer, so install the core
package too.

## Usage

```ts
// start/routes.ts
import { multitenancyAdminRoutes } from '@adonisjs-lasagna/admin'
import { middleware } from '#start/kernel'

multitenancyAdminRoutes({
  prefix: '/admin/multitenancy',
  middleware: middleware.adminAuth(),
})
```

The admin API exposes destructive routes (tenant destroy, impersonation, SSO
config), so it refuses to mount without auth: omit `middleware` and it throws at
startup. To mount it public on purpose (only behind a trusted network
boundary), pass `middleware: false` explicitly.

## Migrating from the core subpath

Before the split this lived at `@adonisjs-lasagna/saas-tenancy/admin`. Update
the import:

```diff
- import { multitenancyAdminRoutes } from '@adonisjs-lasagna/saas-tenancy/admin'
+ import { multitenancyAdminRoutes } from '@adonisjs-lasagna/admin'
```

The old subpath remains as a deprecated shim that throws with this hint for one
minor, then is removed.
