---
title: Admin
description: REST admin API for tenants, impersonation and satellite management, with OpenAPI/Swagger and a fail-closed mount.
---

# Admin

A REST admin API for managing tenants (CRUD, suspend, restore, maintenance),
impersonation, and the satellite resources (audit logs, webhooks, feature flags,
branding, SSO, metrics, quotas), with a generated OpenAPI 3.1 spec and Swagger UI.

The full endpoint reference, request/response shapes and OpenAPI details live in
the [Admin REST API](/docs/satellites/admin-rest-api) page. This page is the satellite
overview: how it installs and the access model.

## Configuration

Admin ships no provider, no commands and no migrations: you mount it yourself in
`start/routes.ts`, because the mount carries a required auth middleware and an
optional actor resolver whose values only your app knows. Its configure hook is
guidance-only and never edits your routes file:

```bash
npm install @adonisjs-lasagna/admin
node ace configure @adonisjs-lasagna/admin   # prints the mount snippet; edits nothing
```

```ts
// start/routes.ts
import { multitenancyAdminRoutes } from '@adonisjs-lasagna/admin'
import { middleware } from '#start/kernel'

multitenancyAdminRoutes({
  middleware: middleware.adminAuth(),                       // REQUIRED; fails closed without it
  resolveAdminActor: ({ auth }) => auth.user?.id ?? null,   // for impersonation
})
```

## Access model

- **Fail-closed mount.** `multitenancyAdminRoutes(...)` requires `middleware` and
  throws at startup if it is absent, empty, or an empty array, so the destructive
  surface can never mount silently public. Pass `middleware: false` only behind a
  trusted network boundary.
- **Impersonation never trusts the body.** The acting admin id comes from your
  `resolveAdminActor` hook, never from the request body. Without the hook the
  impersonation endpoint returns 501; a resolver that returns null yields 401.
- **CSRF is the host's job.** The admin API does not apply CSRF itself; add your
  app's CSRF middleware when mounting behind a cookie/session browser context.
- **Swagger gating.** The OpenAPI spec and Swagger UI inherit `middleware` unless
  you pass `docsAuth: false`, so the surface is not enumerable without auth by
  default.
- **Optional SSO peer.** The SSO endpoints require `@adonisjs-lasagna/sso`; when it
  is not installed they return 501 and the rest of the admin API keeps working.

## Extensibility: custom actions

Register an `AdminAction` on the module-level `adminActionRegistry` to add a
custom operation, dispatched at `POST {prefix}/actions/:name` behind the same
admin auth as the rest of the API. `execute(ctx, signal?)` reads the request and
returns a value. `GET {prefix}/actions` lists registered names and
`GET {prefix}/actions/contract-version` reports the version. Optional `timeoutMs`
/ `rateLimit` guards are passed through `multitenancyAdminRoutes({ actions })`.
Versioned via `ADMIN_CONTRACT_VERSION`; see the
[Extensibility standard](/docs/satellites/extensibility).

## Read next

- [Admin REST API](/docs/satellites/admin-rest-api); the full endpoint and OpenAPI reference.
- [Security](/security); auth, fail-closed mounting, and the actor resolver.
- [Impersonation](/docs/satellites/impersonation); the impersonation model.
- [Production checklist](/docs/production-checklist); the hardening runbook before you ship.
