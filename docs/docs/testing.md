---
title: Testing
description: Helpers for hermetic and integration testing; buildTestTenant, MockTenantRepository, setRequestTenant, withTenant.
---

# Testing

<Callout type="tip" title="Two testing modes">
Most assertions don't need a real database; Lasagna ships
hermetic helpers that let you assert tenant-routing behaviour with
in-memory fakes. Reach for the SQLite memory driver only when your
test needs real SQL round-trips.
</Callout>

## The `/testing` subpath

```ts
import {
  buildTestTenant,
  MockTenantRepository,
  setRequestTenant,
  withTenant,
} from '@adonisjs-lasagna/saas-tenancy/testing'
```

Imports are tree-shaken; the helpers don't pull in production
services unless you use them.

## `buildTestTenant`

Builds a `TenantModelContract`-shaped object with sensible defaults.
Override what you care about:

```ts
const tenant = buildTestTenant({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Acme Corp',
  status: 'active',
})
```

## `MockTenantRepository`

A repository that lives entirely in memory. Useful for unit tests
that exercise services without bringing up a database.

```ts
import { MockTenantRepository } from '@adonisjs-lasagna/saas-tenancy/testing'
import { TENANT_REPOSITORY } from '@adonisjs-lasagna/saas-tenancy'

test('quota service blocks over-limit', async ({ app }) => {
  const repo = new MockTenantRepository([
    buildTestTenant({ id: 'a', plan: 'starter' }),
  ])
  app.container.bind(TENANT_REPOSITORY, () => repo)
  // …
})
```

`MockTenantRepository` implements `each()` (cursor pagination) the
same way the real one does; you can iterate it from
`tenant:exec`-style code paths without surprises.

## `setRequestTenant`

For controller/middleware tests that need a tenant on the request
without going through the full resolver chain:

```ts
import { setRequestTenant } from '@adonisjs-lasagna/saas-tenancy/testing'

const ctx = await app.container.make(HttpContextFactory)
setRequestTenant(ctx, tenant) // memoises onto the request

// ctx.request.tenant() now resolves to `tenant` without hitting the repo
```

## `withTenant`

Test-time convenience over `tenancy.run()`:

```ts
import { withTenant } from '@adonisjs-lasagna/saas-tenancy/testing'

test('post creation respects scope', async () => {
  await withTenant(tenant, async () => {
    await Post.create({ title: 'hi' })
    const all = await Post.all()
    assert.lengthOf(all, 1)
  })
})
```

Activates the bootstrapper registry around the callback, exactly
like production. The shape that survives in tests matches the shape
that runs in production.

## Hermetic bootstrapper factories

The cache, drive, mail, and session bootstrappers each take a
factory you can override in `config/multitenancy.ts` for the test
environment:

```ts
// config/multitenancy.ts (NODE_ENV === 'test')
export default defineConfig({
  cache: { factory: () => new InMemoryCache() },
  drive: { factory: () => new InMemoryDrive() },
})
```

This is the cleanest way to keep tests fast without sacrificing
behavioural fidelity; the bootstrappers run, the wrappers wrap, but
the underlying storage is in-process.

## Integration tests against real PostgreSQL

The package's own test suite runs integration tests against real
Postgres. Patterns to copy:

- `bin/test.integration.ts`; boots a real `Ignitor` rooted at the
  fixture app, hands the runner to `app.testRunner()`.
- `tests/fixtures/`; a minimal AdonisJS app that imports the
  package via the `exports` map.
- `examples/api/`; a complete reference app with 111 e2e tests
  exercising every feature.

The reference suite uses the `compose.test.yml` to bring up
Postgres, Redis, and MailCatcher; everything Lasagna integrates
with; and runs the e2e suite in 4 to 6 minutes on a laptop.

## Read next

- [Examples/api](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/tree/master/examples/api)
 ; the reference suite is the best read.
