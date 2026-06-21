---
title: Cache bootstrapper
description: Per-tenant BentoCache namespaces with cacheFor(tenant). Memory L1, Redis L2, Redis bus for cross-process invalidation.
---

# Cache bootstrapper

The package ships a single shared BentoCache instance (memory L1,
Redis L2, and a Redis bus for cross-process invalidation) plus a
helper that returns a namespace prefixed by the tenant id. The
bootstrapper is registered automatically; you don't have to enable
it.

## `cacheFor(tenant)` — the safe default

```ts
import { cacheFor } from '@adonisjs-lasagna/saas-tenancy/services'

router.get('/me/settings', async ({ request }) => {
  const tenant = await request.tenant()
  const cache = cacheFor(tenant)         // namespace: tenant:<id>
  return cache.getOrSet({
    key: 'settings',
    factory: () => loadSettingsFromDb(tenant.id),
    ttl: 60_000,
  })
})
```

`cacheFor()` accepts either a tenant model (any object with `.id`)
or a raw id string. The id is run through `assertSafeIdentifier`
before the namespace is built, so a crafted id can never escape the
prefix or interpolate Redis metacharacters. Two tenants writing the
same logical key under `cacheFor()` see independent values.

## `getCache()` — the shared instance

For cross-tenant data (feature-flag definitions, plan catalogs,
anything global), reach for the unprefixed instance:

```ts
import { getCache } from '@adonisjs-lasagna/saas-tenancy/services'

const flags = await getCache().namespace('feature-flags').get({
  key: 'global-killswitch',
})
```

The trade-off: namespace hygiene is on you. `cacheFor()` is the
default; only drop down to `getCache()` when the data is genuinely
not tenant-scoped.

## L1 / L2 / bus

| Layer | Driver | Purpose |
|---|---|---|
| L1 | in-process memory (5 MB cap) | sub-microsecond reads on the hot path |
| L2 | Redis (`config.cache.redis`) | shared across processes, survives restart |
| Bus | Redis pub/sub | a `delete` on one process invalidates L1 on the others |

Configure the Redis connection at `multitenancy.cache.redis` in
`config/multitenancy.ts`:

```ts
export default defineConfig({
  cache: {
    ttl: 300,
    redis: { host: env.get('CACHE_REDIS_HOST'), port: env.get('CACHE_REDIS_PORT'), db: 2 },
  },
})
```

## Tenant id validation

`cacheFor()` always validates the id against
`/^[a-zA-Z0-9_-]{1,63}$/`. Crafted ids (path traversal, embedded
colons, newlines, anything that could collide with another tenant's
prefix) are rejected synchronously before any Redis call:

```ts
cacheFor('../etc')         // throws Error: Refusing to use unsafe tenant id
cacheFor('id:with:colons') // throws
cacheFor('')               // throws
```


## Read next

- [Bootstrappers](/docs/bootstrappers/); the rest of the per-tenant services.
- [Configuration](/docs/configuration); the cache options.
- [Background jobs](/docs/jobs); cache access inside tenant jobs.
