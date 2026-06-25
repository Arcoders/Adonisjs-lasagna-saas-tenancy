# @adonisjs-lasagna/admin

Admin REST API + OpenAPI 3.1 spec + Swagger UI for
[`@adonisjs-lasagna/saas-tenancy`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy).

[![Stability: experimental](https://img.shields.io/badge/stability-experimental-E0A106)](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/reference/stability)

> **Experimental.** This satellite works and is covered by tests, but it is not part of the 1.x stability promise: its surface may change in a minor release. Pin the version and read the changelog before upgrading. See the [stability matrix](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/reference/stability).

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
