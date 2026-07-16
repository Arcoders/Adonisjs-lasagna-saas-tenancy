---
title: Admin REST API
description: A REST admin API exposing tenant lifecycle, satellite configuration, and operational tasks. OpenAPI 3.1 spec ships in the box.
---

# Admin REST API

<Callout type="tip" title="One mental model">
Anything Lasagna's CLI commands do, the REST API does too. The CLI
is a convenience over the same service surface.
</Callout>

## Auth

The admin API is **fail-closed**. `multitenancyAdminRoutes(...)` requires a
`middleware` option and throws at startup if you omit it, so the destructive
routes can never mount silently public. Authentication is your app's
responsibility: pass your auth middleware (session, bearer token, mTLS, etc.)
via that option. The package ships **no** built-in token check. To mount the
routes public on purpose (only behind a trusted network boundary), pass
`middleware: false` explicitly. See
[security hardening](/guides/deployment#security-hardening) for recommended
host-side wiring.

```bash
# Example assuming your auth middleware accepts a bearer token:
curl -H "Authorization: Bearer $TOKEN" \
  https://app.example.com/admin/multitenancy/tenants
```

For a concrete starting point, the demo app gates its mount with a real
`@adonisjs/auth` access-tokens guard over a dedicated operator model
(`examples/api/app/models/backoffice/backoffice_user.ts`, wired in
`examples/api/start/routes.ts`). The [authentication guide](/guides/authentication)
walks through that two-realm setup; session or mTLS checks slot into the same
`middleware` seam.

One footgun the boot guard closes for you: a pattern like
`middleware: authEnabled ? [adminAuth] : []` would, when the flag is off, mount
the destructive routes public while *looking* guarded. The startup check rejects
an empty middleware array the same way it rejects an omitted one, so "looks
guarded but is public" cannot happen. Going public is only possible by writing
`middleware: false` on purpose.

### CSRF

The admin API does **not** apply CSRF protection itself. If you mount it behind a
cookie/session-authenticated browser context, apply your app's CSRF middleware to
these routes (`@adonisjs/shield` or your own). Token/bearer-authenticated callers
(the common case for an admin API) are not exposed to CSRF, so this matters only
when the auth is cookie-based.

### Swagger / OpenAPI exposure

The OpenAPI spec and Swagger UI are gated by your `middleware` by default
(`docsAuth: true`): the spec maps the whole surface, including impersonation and
destructive routes, so leaving it public lets an attacker enumerate the API
without tripping auth. Pass `docsAuth: false` only when you intend to publish the
spec (a developer portal, an internal Stoplight, etc.).

### SSO endpoints need the SSO satellite

The `/tenants/{id}/sso*` endpoints require `@adonisjs-lasagna/sso` (an optional
peer of admin). When it is not installed they return **501 Not Implemented**
rather than failing the whole admin module to load. The rest of the admin API
works without it.

## Mounting

```ts
// start/routes.ts
import { multitenancyAdminRoutes } from '@adonisjs-lasagna/admin'
import { middleware } from '#start/kernel'

multitenancyAdminRoutes({
  prefix: '/admin/multitenancy',
  middleware: middleware.adminAuth(),
})
```

The admin API lives in its own package (`@adonisjs-lasagna/admin`), installed
alongside the core. `middleware` is required: omit it and the call throws at
startup, since the surface includes destructive routes. To mount it public on
purpose (only behind a trusted network boundary), pass `middleware: false`.

## OpenAPI 3.1 spec

The spec is generated from the service contract; there is no
separate hand-written schema. Two surfaces:

- **JSON spec**: `GET /admin/multitenancy/openapi.json`
- **Swagger UI**: `GET /admin/multitenancy/docs`

Pin the JSON spec into your CI to detect breaking changes between
package versions.

## Endpoints (selection)

Full list lives in the OpenAPI spec; here are the categories:

### Tenants

```
GET    /tenants
GET    /tenants/{id}
POST   /tenants
POST   /tenants/{id}/activate
POST   /tenants/{id}/suspend
POST   /tenants/{id}/destroy
POST   /tenants/{id}/restore
POST   /tenants/{id}/maintenance
DELETE /tenants/{id}/maintenance
GET    /tenants/{id}/queue/stats
```

### Impersonation

```
POST   /tenants/{id}/impersonations
DELETE /impersonations/{token}
DELETE /impersonations/by-id/{sessionId}
```

`POST /impersonations` starts a session: body `userId` (required), `durationSeconds`
(optional), and `reason` (optional). The acting admin is **never** read from the body; it
comes from the `resolveAdminActor` hook you pass to `multitenancyAdminRoutes`. Without that
hook the route is fail-closed and returns `501 admin_actor_resolver_not_configured`; if the
hook resolves no admin it returns `401 admin_actor_unresolved`. A missing `userId` is
`400 userId_required`.

Revoke with either `DELETE /impersonations/{token}` (the token handed back at start) or
`DELETE /impersonations/by-id/{sessionId}`. Both return `{ revoked: boolean }`.

### Audit logs

```
GET /tenants/{id}/audit-logs?from=…&to=…
```

### Feature flags

```
GET    /tenants/{id}/feature-flags
POST   /tenants/{id}/feature-flags
PUT    /tenants/{id}/feature-flags/{key}
DELETE /tenants/{id}/feature-flags/{key}
```

`POST`/`PUT` accept `flag` (POST only), `enabled` (boolean), `config` (optional
object), and `expiresAt` (optional ISO 8601; once past, the flag evaluates as
disabled). An invalid `expiresAt` returns `400 invalid_expires_at`; omitting it
clears any stored expiry. Each row serializes with an `expiresAt` field.

### Webhooks

```
GET    /tenants/{id}/webhooks
POST   /tenants/{id}/webhooks
PUT    /tenants/{id}/webhooks/{webhookId}
DELETE /tenants/{id}/webhooks/{webhookId}
GET    /tenants/{id}/webhooks/{webhookId}/deliveries
POST   /tenants/{id}/webhooks/deliveries/{deliveryId}/retry
```

When the `POST` body omits `secret`, the service generates one and the
201 response carries it as a top-level `secret` field; that is the
only time the plaintext is disclosed. It is stored encrypted; later
responses only report `hasSecret: true`.

The `retry` route manually replays a delivery: it re-validates the stored URL
against the SSRF guard, then re-sends immediately and returns the updated
delivery. It answers `422 webhook_url_unsafe` if the URL no longer passes
validation, and `403 delivery_belongs_to_other_tenant` if the delivery is not
owned by `{id}`.

### Branding

```
GET /tenants/{id}/branding
PUT /tenants/{id}/branding
```

### SSO

```
GET  /tenants/{id}/sso
PUT  /tenants/{id}/sso
POST /tenants/{id}/sso/disable
```

`GET` returns the tenant's stored SSO config, `PUT` upserts it, and `POST /sso/disable`
turns SSO off while keeping the stored config. All three require the
`@adonisjs-lasagna/sso` peer; without it they answer `501 Not Implemented` (see above).

### Metrics & quotas

```
GET  /tenants/{id}/metrics?days=…
GET  /tenants/{id}/quotas
PUT  /tenants/{id}/quotas/usage
POST /tenants/{id}/quotas/reset
```

`GET /metrics` takes `days` (1–365, default 30) and returns `{ data: [...], days }`, each
row carrying `period`, `requestCount`, `errorCount`, and `bandwidthBytes`.

`GET /quotas` returns the plan snapshot under `data`. It answers `503 quotas_unavailable`
when `plans` is not configured, with a `hint` to declare `plans` in `config/multitenancy.ts`.

`PUT /quotas/usage` sets a single counter: body `quota` (string) and `value` (a
non-negative number). It returns `{ tenantId, quota, usage }`, and rejects a missing quota
with `400 quota_required` or a bad value with `400 value_must_be_non_negative_number`.

`POST /quotas/reset` clears usage: body `quota` (optional) resets one counter, or all of
them when omitted. Returns `{ tenantId, reset }` (the quota name, or `"all"`).

### Custom actions

Host apps register their own admin operations through the
[admin-action registry](/guides/satellites/admin#custom-actions); they surface here:

```
GET  /actions
GET  /actions/contract-version
POST /actions/{name}
```

`GET /actions` lists the registered action names under `data`. `GET /actions/contract-version`
reports the admin-action contract version this build implements. `POST /actions/{name}`
dispatches one and returns `{ data: <result> }`; an unknown or unsafe `{name}` is a `404`
(the registry is never queried with untrusted input). Wire optional per-action `timeoutMs`
and `rateLimit` guards through the `actions` option of `multitenancyAdminRoutes`.

### Health

```
GET /health/report
```

`GET /health/report` runs `DoctorService` and returns its report. The status code is `503`
when the report contains any error-level check and `200` otherwise, so it drops straight
into an uptime probe.

## Versioning

The spec is versioned with the package; `info.version` mirrors
`package.json` `version`. Breaking changes go through major bumps.
Use the spec as a contract: generate clients, validate requests
in CI.

## Read next

- [Security](/guides/security); auth, fail-closed mounting, and the actor resolver.
- [Authentication](/guides/authentication); wiring your guard in front of the API.
- [CLI commands](/reference/commands); the same operations from the terminal.
- [Production checklist](/reference/production-checklist); the hardening runbook before you ship.
