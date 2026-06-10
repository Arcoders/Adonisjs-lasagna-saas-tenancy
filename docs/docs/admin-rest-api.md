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
[security hardening](/docs/deployment#security-hardening) for recommended
host-side wiring.

```bash
# Example assuming your auth middleware accepts a bearer token:
curl -H "Authorization: Bearer $TOKEN" \
  https://app.example.com/admin/multitenancy/tenants
```

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

### Audit logs

```
GET /tenants/{id}/audit-logs?from=…&to=…
```

### Feature flags

```
GET    /tenants/{id}/feature-flags
PUT    /tenants/{id}/feature-flags/{key}
DELETE /tenants/{id}/feature-flags/{key}
```

### Webhooks

```
GET    /tenants/{id}/webhooks
POST   /tenants/{id}/webhooks
DELETE /tenants/{id}/webhooks/{webhookId}
GET    /tenants/{id}/webhooks/{webhookId}/deliveries
```

### Branding

```
GET /tenants/{id}/branding
PUT /tenants/{id}/branding
```

### SSO

```
GET /tenants/{id}/sso
PUT /tenants/{id}/sso
```

### Metrics & quotas

```
GET /tenants/{id}/metrics?key=…&from=…&to=…
GET /tenants/{id}/quotas
PUT /tenants/{id}/plans/{plan}
```

### Operations

```
POST /tenants/{id}/backup
POST /tenants/{id}/restore
POST /tenants/{id}/clone
GET  /health
```

## Versioning

The spec is versioned with the package; `info.version` mirrors
`package.json` `version`. Breaking changes go through major bumps.
Use the spec as a contract: generate clients, validate requests
in CI.

## Read next

- [Security](/security); auth, fail-closed mounting, and the actor resolver.
- [Authentication](/docs/authentication); wiring your guard in front of the API.
- [CLI commands](/docs/commands); the same operations from the terminal.
