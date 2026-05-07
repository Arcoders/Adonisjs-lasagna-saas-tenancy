---
title: Feature flags
description: Per-tenant feature flags with percentage rollout. Backed by the backoffice schema, cached per tenant.
---

# Feature flags

Boolean and percentage-rollout flags scoped to a tenant. Use them
for gradual rollouts, kill switches, and beta cohorts.

## Configuration

```bash
node ace configure @adonisjs-lasagna/saas-tenancy --with=feature_flags
```

## API

```ts
import { FeatureFlagService } from '@adonisjs-lasagna/saas-tenancy/services'

const flags = await app.container.make(FeatureFlagService)

// Boolean
if (await flags.isEnabled('new-checkout', { tenantId: tenant.id })) {
  // …
}

// Percentage rollout — stable hash on userId so a single user
// stays in the same bucket across requests.
if (await flags.isEnabled('beta-dashboard', {
  tenantId: tenant.id,
  bucketKey: user.id,
})) {
  // …
}
```

## Storage

`tenant_feature_flags` rows have:

| Column | Notes |
|---|---|
| `id` | UUID v4 |
| `tenant_id` | FK |
| `key` | Flag name |
| `enabled` | Boolean kill switch |
| `rollout_percent` | 0..100; null means use `enabled` only |
| `bucket_key` | Optional override of which field to hash |

The cache key is `tenants/<id>/feature-flags/<key>`; the cache
bootstrapper takes care of the namespacing automatically.

## Admin REST

```http
GET    /admin/multitenancy/tenants/{id}/feature-flags
PUT    /admin/multitenancy/tenants/{id}/feature-flags/{key}
DELETE /admin/multitenancy/tenants/{id}/feature-flags/{key}
```

## Limits

- Flag evaluation is cached for 60 s by default. Tune
  `featureFlags.cacheTtl` to taste.
- Percentage rollout uses xxhash64; lookups are O(1). Don't reach for
  this satellite for personalisation; there are better tools.
