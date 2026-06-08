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

const flags = await app.container.make(FeatureFlagService)

// Evaluate (cached per tenant for 60s). Returns false for unknown flags.
if (await flags.isEnabled(tenant.id, 'new-checkout')) {
  // …
}

// Set / unset a flag. The optional config object is stored verbatim.
await flags.set(tenant.id, 'new-checkout', true)
await flags.set(tenant.id, 'beta-dashboard', true, { note: 'cohort A' })

// List every flag for a tenant, or remove one.
const all = await flags.listForTenant(tenant.id)
await flags.delete(tenant.id, 'beta-dashboard')
```

Method signatures:

| Method | Returns |
|---|---|
| `isEnabled(tenantId, flag)` | `Promise<boolean>` (false when the flag is absent) |
| `set(tenantId, flag, enabled, config?)` | `Promise<TenantFeatureFlag>` (upsert) |
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
| `created_at` / `updated_at` | timestamps |

`isEnabled` reads through a per-tenant cache: a tenant's whole flag map is cached
under `ff_map:<tenantId>` in the `feature_flags` cache namespace for 60s, and
`set`/`delete` bust it.

## Admin REST

```http
GET    /admin/multitenancy/tenants/{id}/feature-flags
PUT    /admin/multitenancy/tenants/{id}/feature-flags/{key}
DELETE /admin/multitenancy/tenants/{id}/feature-flags/{key}
```

## Notes

- Evaluation is a boolean kill switch. There is no built-in percentage rollout: if
  you need gradual rollouts, store the percentage in `config` and bucket on it in
  your own code, or reach for a dedicated experimentation tool.
- Flags are cached for 60s, so a `set` takes up to a minute to propagate on cache
  hits.
