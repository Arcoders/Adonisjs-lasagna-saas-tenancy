# @adonisjs-lasagna/admin

Admin REST API + OpenAPI 3.1 spec + Swagger UI for
[`@adonisjs-lasagna/saas-tenancy`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy).

[![Stability: release candidate](https://img.shields.io/badge/stability-release_candidate-C26A4B)](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/reference/stability)

> **Stability: release candidate.** The API is frozen under the 1.x promise, with the honest caveat that a correction forced by the pending security review or production mileage may land in a 1.x minor with a loud changelog entry. Pin the version and read the changelog before upgrading. See the [stability matrix](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/reference/stability).

This package was split out of the core so the admin surface (tenant CRUD,
impersonation, satellite management) versions on its own cadence and is only
installed by apps that mount it.

## Install

```bash
npm i @adonisjs-lasagna/admin
```

It declares `@adonisjs-lasagna/saas-tenancy` as a peer, so install the core
package too. `@adonisjs-lasagna/sso` is an optional peer: install it only if you
use the SSO admin endpoints.

## Usage

```ts
// start/routes.ts
import { multitenancyAdminRoutes } from '@adonisjs-lasagna/admin'
import { middleware } from '#start/kernel'

multitenancyAdminRoutes({
  prefix: '/admin/multitenancy',                          // default; shown for clarity
  middleware: middleware.adminAuth(),                     // REQUIRED; fails closed without it
  resolveAdminActor: ({ auth }) => auth.user?.id ?? null, // attributes audit rows + impersonation
})
```

## Endpoint surface

All routes are relative to `prefix` (default `/admin/multitenancy`). The
generated OpenAPI document at `GET {prefix}/openapi.json` is the full contract;
`GET {prefix}/docs` serves Swagger UI.

| Area | Routes |
|---|---|
| Tenants | list / create / show / activate / suspend / destroy / restore / maintenance |
| Impersonation | start, revoke by token, revoke by session id |
| Audit | read a tenant's audit log (paginated, date-range filterable) |
| Webhooks | list / create / update / delete / deliveries / retry |
| Feature flags | list / create / update / delete (with optional expiry) |
| Branding | show / update |
| SSO | show / update / disable (optional `@adonisjs-lasagna/sso` peer) |
| Metrics & quotas | per-tenant metrics, quota snapshot / set-usage / reset |
| Custom actions | host-registered actions at `POST {prefix}/actions/:name` |
| Health | doctor report, OpenAPI spec, Swagger UI |

## Security and access model

- **Fail-closed mount.** `multitenancyAdminRoutes(...)` refuses to mount without
  `middleware`. Omitting it, or passing an empty array, throws at startup so the
  destructive surface can never go public by accident. Pass `middleware: false`
  only behind a trusted network boundary.
- **Audit attribution.** Every mutating action (tenant lifecycle, webhooks,
  feature flags, branding, SSO, quotas, and custom-action dispatch) writes an
  attributed, append-only row to the audit log under an `admin:<resource>:<verb>`
  action name. The acting admin comes from your `resolveAdminActor` hook, never
  from the request body, and a secret is never recorded in the metadata. Auditing
  is best-effort: it never fails the operation it records.
- **Impersonation never trusts the body.** The acting admin id comes from
  `resolveAdminActor`. Without it the impersonation endpoint returns 501; a
  resolver that returns null yields 401.
- **CSRF is the host's job.** Add your app's CSRF middleware when mounting behind
  a cookie/session browser context.
- **Swagger gating.** The spec and Swagger UI inherit `middleware` unless you
  pass `docsAuth: false`, so the surface is not enumerable without auth by default.
- **Optional SSO peer.** The SSO endpoints require `@adonisjs-lasagna/sso`; when
  it is absent they return 501 and the rest of the API keeps working.
- **Rate limiting.** Throttling destructive endpoints is the host's job;
  `actions.rateLimit` is available for custom actions.

## Impersonation

Operators enter a tenant as a specific user with a time-boxed, tenant-bound,
HMAC-signed, revocable token. The lifecycle is audited under
`admin:impersonate:start`, `admin:impersonate:first-use`, and
`admin:impersonate:stop`. An impersonated request carries `ctx.impersonation`
(`adminId`, `targetUserId`, `tenantId`, `reason`, timestamps), so you can flag it
in your own logs. See the [Impersonation guide](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/guides/satellites/impersonation).

## Testing and coverage

The package ships unit specs (the fail-closed mount guard, the OpenAPI document,
the actor resolver, and a source-scan guard that proves every mutating handler
audits and never logs a secret) and integration specs that drive the REST
surface against real Postgres. End-to-end flows live in the core repo's
`examples/api`. The merged unit + integration coverage floor is enforced per
package (lines 87 / functions 78 / branches 70).

## Full documentation

This README is a summary; the docs site is the source of truth.

- [Admin](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/guides/satellites/admin); install, access model, audit and accountability, the actor resolver.
- [Admin REST API](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/guides/satellites/admin-rest-api); the full endpoint and OpenAPI reference.
- [Impersonation](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/guides/satellites/impersonation); the impersonation model.
- [Audit logs](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/guides/satellites/audit); the append-only trail, retention, and export.

## Migrating from the core subpath

Before the split this lived at `@adonisjs-lasagna/saas-tenancy/admin`. Update
the import:

```diff
- import { multitenancyAdminRoutes } from '@adonisjs-lasagna/saas-tenancy/admin'
+ import { multitenancyAdminRoutes } from '@adonisjs-lasagna/admin'
```

The old subpath remains as a deprecated shim that throws with this hint for one
minor, then is removed.
