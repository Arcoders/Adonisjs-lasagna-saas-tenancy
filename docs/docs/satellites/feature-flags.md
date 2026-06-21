---
title: Feature flags
description: Per-tenant boolean feature flags backed by the backoffice schema, cached per tenant.
---

# Feature flags

Boolean feature flags scoped to a tenant. Use them for kill switches and beta
cohorts. Each flag is on or off for a tenant; an optional free-form `config`
object rides alongside for whatever metadata your app wants to attach.

## Configuration

```bash
node ace configure @adonisjs-lasagna/saas-tenancy --with=feature_flags
```

## API

```ts
import { FeatureFlagService } from '@adonisjs-lasagna/saas-tenancy/services'
import { DateTime } from 'luxon'

const flags = await app.container.make(FeatureFlagService)

// Evaluate (cached per tenant for 60s). Returns false for unknown flags, and
// false once a flag's expiry has passed.
if (await flags.isEnabled(tenant.id, 'new-checkout')) {
  // …
}

// Read one flag's stored state without listing them all. Returns null when
// unset. Unlike isEnabled, this does NOT apply expiry — it's a data accessor,
// handy when you only need the config (e.g. a rollout percentage).
const f = await flags.getFlag(tenant.id, 'new-checkout')
// → { enabled: true, config: { rollout: 25 }, expiresAt: null } | null

// Set / unset a flag. config is stored verbatim; expiresAt (a luxon DateTime)
// is optional — after it passes, isEnabled returns false.
await flags.set(tenant.id, 'new-checkout', true)
await flags.set(tenant.id, 'beta-dashboard', true, { note: 'cohort A' })
await flags.set(tenant.id, 'xmas-banner', true, null, DateTime.fromISO('2026-12-26T00:00:00Z'))

// List every flag for a tenant, or remove one.
const all = await flags.listForTenant(tenant.id)
await flags.delete(tenant.id, 'beta-dashboard')
```

Method signatures:

| Method | Returns |
|---|---|
| `isEnabled(tenantId, flag)` | `Promise<boolean>` (false when absent or expired) |
| `getFlag(tenantId, flag)` | `Promise<{ enabled, config, expiresAt } \| null>` (raw stored record; does not apply expiry) |
| `set(tenantId, flag, enabled, config?, expiresAt?)` | `Promise<TenantFeatureFlag>` (upsert) |
| `listForTenant(tenantId)` | `Promise<TenantFeatureFlag[]>` |
| `delete(tenantId, flag)` | `Promise<void>` |

## Storage

`tenant_feature_flags` rows have:

| Column | Notes |
|---|---|
| `id` | UUID v4 |
| `tenant_id` | the owning tenant |
| `flag` | flag name |
| `enabled` | boolean on/off |
| `config` | optional free-form JSON; opaque to the service, not used to evaluate the flag |
| `expires_at` | optional timestamp; once past, `isEnabled` returns false |
| `created_at` / `updated_at` | timestamps |

`isEnabled` reads through a per-tenant cache: a tenant's whole flag map is cached
under `ffm2:<tenantId>` in the `feature_flags` cache namespace for 60s, and
`set`/`delete` bust it. Expiry is compared at read time against the stored
`expires_at`, so a flag flips off exactly on its deadline regardless of the cache.

## CLI

Manage flags from a terminal (handy for scripting and environments without HTTP):

```bash
node ace tenant:feature-flag:set <tenantId> <flag> true --config='{"rollout":25}' --expires-at=2026-12-31T23:59:59Z
node ace tenant:feature-flag:get <tenantId> <flag>     # prints the stored row as JSON, or null
node ace tenant:feature-flag:list <tenantId> [--json]  # table, or a JSON array
node ace tenant:feature-flag:delete <tenantId> <flag> [--force]
```

`get` and `list` read the database directly. `set` and `delete` go through the
service so they invalidate the shared cache; they need Redis reachable.

## Admin REST

```http
GET    /admin/multitenancy/tenants/{id}/feature-flags
POST   /admin/multitenancy/tenants/{id}/feature-flags
PUT    /admin/multitenancy/tenants/{id}/feature-flags/{key}
DELETE /admin/multitenancy/tenants/{id}/feature-flags/{key}
```

`POST`/`PUT` accept an optional `expiresAt` (ISO 8601); an invalid value is
rejected with `400 invalid_expires_at`. Omitting it clears any stored expiry
(same as `config`).

## Notes

- Evaluation is a boolean kill switch. There is no built-in percentage rollout: if
  you need gradual rollouts, store the percentage in `config` and bucket on it in
  your own code, or reach for a dedicated experimentation tool.
- Flags are cached for 60s, so a `set` takes up to a minute to propagate on cache
  hits.


## Read next

- [Admin REST API](/docs/satellites/admin-rest-api); toggling flags over HTTP.
- [Configuration](/docs/configuration); the flag defaults.
- [Production checklist](/docs/production-checklist); the hardening runbook before you ship.
- [Satellites](/docs/satellites/); the rest of the opt-in features.
