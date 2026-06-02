---
title: Admin REST API
description: 36 endpoints exposing tenant lifecycle, satellite configuration, and operational tasks. OpenAPI 3.1 spec ships in the box.
---

# Admin REST API

<Callout type="tip" title="One mental model">
Anything Lasagna's CLI commands do, the REST API does too. The CLI
is a convenience over the same service surface.
</Callout>

## Auth

The route group is gated by an `x-admin-token` header checked
against `config.adminToken`. The package does **not** add IP
allow-listing, mTLS, or auth integration; see
[security hardening](/docs/deployment#security-hardening) for the
recommended host-side wiring.

```bash
curl -H "x-admin-token: $TOKEN" \
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
- **Swagger UI**: `GET /admin/multitenancy/openapi`

Pin the JSON spec into your CI to detect breaking changes between
package versions.

## Endpoints (selection)

Full list lives in the OpenAPI spec; here are the categories:

### Tenants

```
GET    /tenants
GET    /tenants/{id}
POST   /tenants
PUT    /tenants/{id}/activate
PUT    /tenants/{id}/suspend
DELETE /tenants/{id}
PUT    /tenants/{id}/restore
PUT    /tenants/{id}/maintenance
DELETE /tenants/{id}/maintenance
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
