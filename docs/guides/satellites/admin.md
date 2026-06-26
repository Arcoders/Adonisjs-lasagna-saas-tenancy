---
title: Admin
description: REST admin API for tenants, impersonation and satellite management, with OpenAPI/Swagger and a fail-closed mount.
---

# Admin

A REST admin API for managing tenants (CRUD, suspend, restore, maintenance),
impersonation, and the satellite resources (audit logs, webhooks, feature flags,
branding, SSO, metrics, quotas), with a generated OpenAPI 3.1 spec and Swagger UI.

The full endpoint reference, request/response shapes and OpenAPI details live in
the [Admin REST API](/guides/satellites/admin-rest-api) page. This page is the satellite
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

## Audit & accountability

Every mutating admin action is recorded automatically in the append-only audit
log the moment it succeeds. The acting admin comes from your `resolveAdminActor`
hook (never the request body), the row lands in `backoffice.tenant_audit_logs`,
and a secret is never written to the metadata. Auditing is best-effort by design:
a missing resolver or an unreachable audit table degrades to a swallowed no-op
rather than failing the operation it records.

Actions follow one convention, `admin:<resource>:<verb>`, shared across REST and
the equivalent ace commands. The caller is distinguished by `actorType`
(`admin` when an operator id resolves, `system` for an unattributed privileged
context), not by the action name.

| Action | Fires on | Metadata (ids and flags only) |
|---|---|---|
| `admin:tenant:create` | tenant created (`POST /tenants`, `tenant:create`) | `name`, `status` |
| `admin:tenant:activate` | tenant activated | `status` |
| `admin:tenant:suspend` | tenant suspended | `status` |
| `admin:tenant:destroy` | tenant soft-deleted / torn down | `status`, `schemaDropped` |
| `admin:tenant:restore` | soft-deleted tenant restored | `status` |
| `admin:tenant:maintenance_enter` / `_exit` | maintenance toggled | `hasMessage` (on enter) |
| `admin:webhook:create` / `update` / `delete` / `retry` | webhook changes and re-sends | `webhookId` (+ `url`, `events`, `secretGenerated`, `changed`, `deliveryId`) |
| `admin:feature_flag:create` / `update` / `delete` | flag changes | `flag`, `enabled`, `hasExpiry` |
| `admin:branding:update` | branding upsert | `changed` (the keys supplied) |
| `admin:sso:update` / `disable` | SSO config changes | `provider`, `clientId`, `issuerUrl`, `enabled` (never the `clientSecret`) |
| `admin:quota:set_usage` / `reset` | quota usage written or cleared | `quota`, `value` |
| `admin:action:dispatch` | a host-registered custom action runs | `name` (never the body or result) |
| `admin:impersonate:start` / `first-use` / `stop` | impersonation lifecycle | session id, target user, duration, reason |

Idempotent no-ops do not write a row: an already-suspended tenant, a webhook
`PUT` with an empty body, or disabling an already-disabled SSO config all
short-circuit with `unchanged: true` and audit nothing. A delete of a missing
webhook or feature flag returns 404 and records nothing, so the trail never
contains a deletion that did not happen.

A serialized row looks like this:

```json
{
  "actorType": "admin",
  "actorId": "user-42",
  "action": "admin:tenant:suspend",
  "tenantId": "1f1b…",
  "metadata": { "status": "suspended" },
  "ipAddress": "203.0.113.10",
  "createdAt": "2026-06-26T12:00:00.000Z"
}
```

Rows are immutable at the database level: three PostgreSQL triggers reject
`UPDATE`, `DELETE`, and `TRUNCATE`. Read them over HTTP at
`GET {prefix}/tenants/:id/audit-logs?from=…&to=…` (paginated, date-range
filterable) or export the full trail with `node ace tenant:audit:export`.

## Configuring the admin actor resolver

`resolveAdminActor` extracts the acting admin id from the authenticated context.
It powers both impersonation and the audit attribution above.

```ts
// start/routes.ts
import { multitenancyAdminRoutes } from '@adonisjs-lasagna/admin'
import { middleware } from '#start/kernel'

multitenancyAdminRoutes({
  middleware: middleware.adminAuth(),
  resolveAdminActor: ({ auth }) => auth.user?.id ?? null,
})
```

<Callout type="warning" title="The resolver records who, not what's allowed">
<code>resolveAdminActor</code> must sit <strong>behind</strong> your
authorization checks. It records <em>who</em> acted, not <em>which permission</em>
allowed it. Per-action permission gating (RBAC) belongs in your middleware or
policies, not in the package. Never read the admin id from the request body.
</Callout>

The same operation run from the terminal is attributed too: the lifecycle ace
commands (`tenant:create`, `tenant:activate`, `tenant:suspend`, `tenant:destroy`,
`tenant:maintenance`) accept `--admin=<id>` to attribute the row to an operator.
Without it the action is recorded as `system`.

## Retention & monitoring

Admin actions land in `backoffice.tenant_audit_logs`, and retention is your
responsibility: the package only writes append-only rows, it never prunes them.
The two supported patterns (ship to a long-term store then purge under a
privileged role, or partition by month and detach old partitions) are covered in
the [Audit logs guide](/guides/satellites/audit). For monitoring, register an
`AuditLogDestinationRegistry` destination to fan rows out to a SIEM, and alert on
high-signal actions. For example, surface every `admin:tenant:destroy` without a
matching change ticket:

```bash
node ace tenant:audit:export --format=json \
  | jq 'select(.action == "admin:tenant:destroy")'
```

## Auditing denied attempts

A caller rejected by your auth middleware (401/403) never reaches the package, so
the admin API cannot record a denial it never sees. That is the correct boundary.
To audit denied attempts, write the row in your own auth middleware:

```ts
import { AuditLogService } from '@adonisjs-lasagna/saas-tenancy/services'

const audit = await app.container.make(AuditLogService)
await audit.log({
  actorType: 'admin',
  action: 'admin:access:denied',
  metadata: { reason: 'missing_scope' },
  ipAddress: ctx.request.ip(),
})
```

## Extensibility: custom actions

Register an `AdminAction` on the module-level `adminActionRegistry` to add a
custom operation, dispatched at `POST {prefix}/actions/:name` behind the same
admin auth as the rest of the API. `execute(ctx, signal?)` reads the request and
returns a value. `GET {prefix}/actions` lists registered names and
`GET {prefix}/actions/contract-version` reports the version. Optional `timeoutMs`
/ `rateLimit` guards are passed through `multitenancyAdminRoutes({ actions })`.
Versioned via `ADMIN_CONTRACT_VERSION`; see the
[Extensibility standard](/guides/extensibility).

## Read next

- [Admin REST API](/guides/satellites/admin-rest-api); the full endpoint and OpenAPI reference.
- [Audit logs](/guides/satellites/audit); the append-only trail, retention, and export.
- [Security](/guides/security); auth, fail-closed mounting, and the actor resolver.
- [Impersonation](/guides/satellites/impersonation); the impersonation model.
- [Production checklist](/reference/production-checklist); the hardening runbook before you ship.
