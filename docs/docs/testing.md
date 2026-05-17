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

## Coverage matrix

Where each feature is exercised in the package's own test suite, and
against what real dependency. Mock-vs-real is explicit so a consumer
knows which guarantees come from in-process doubles and which come
from a live backend.

| Feature                          | Unit | Integration (real backend)                                                | E2E (demo `examples/api`)                  |
|----------------------------------|:----:|---------------------------------------------------------------------------|--------------------------------------------|
| Tenant lifecycle (install/destroy/migrate/seed/clone/purge) | ✓ | Postgres (`schema_pg_driver`, `clone_service`)                            | Real ace commands + HTTP                   |
| Maintenance mode / Impersonate (ace command) | ✓ | —                                                                         | Real ace commands (`commands_lifecycle`)   |
| Tenant guard / not-ready / suspended / circuit-open | ✓ | Postgres (`tenant_guard_middleware`)                                      | Real HTTP `/tenant/*`                      |
| Custom domain middleware         | ✓ | Postgres (`custom_domain_middleware`)                                     | Real HTTP                                  |
| Rate limit middleware            | ✓ | **Real Redis** (`middleware/rate_limit`) — incl. fail-closed/fail-open    | Real HTTP                                  |
| Impersonation lifecycle          | ✓ | Real Redis (`impersonation_lifecycle`) + Real HTTP (`impersonation_middleware`) | `tenant:impersonate` command          |
| Bootstrappers (cache/drive/session/transmit) | ✓ | **Real Redis** for cache; **real fs** for drive prefix; cross-tenant isolation + 16-way `AsyncLocalStorage` concurrency (`bootstrapper_isolation`) | —                                          |
| Doctor checks (10 built-in)      | ✓ | Real Postgres + Redis + Opossum (`doctor/doctor_checks_real`)             | —                                          |
| Quota service / Plans            | ✓ | **Real Redis** (`quota_concurrency`)                                       | Real HTTP `/demo/notes` (`lifecycle_events`) |
| Circuit breaker                  | ✓ | Real Opossum + Redis (`circuit_breaker_service`)                          | —                                          |
| Backups — local `pg_dump`/`pg_restore` | ✓ | —                                                                         | **Real `pg_dump`** (`backups_real`)        |
| Backups — S3                     | ✓ | **Real S3** via MinIO container (`services/backup_s3`)                    | —                                          |
| SSO / OIDC                       | ✓ | Fake IdP + JWKS in-spec (`sso_oidc_flow`) **plus** real `mock-oauth2-server` container (`sso_oidc_real`) | —                                          |
| Billing — Stripe SDK             | ✓ | `MockStripe` double for the bulk + **real Stripe test API** smoke (`stripe_real_smoke`) | Real webhook receiver                      |
| Webhooks outbound (HMAC/retry)   | ✓ | Real HTTP receiver in-spec (`webhook_service`)                            | Real HTTP (`webhooks_delivery`)            |
| Queue jobs (`InstallTenant`, `UninstallTenant`, `ProcessStripeEventJob`, …) | ✓ | Inline dispatch (`webhook_idempotency`)                                   | **Real `queue:work` subprocess** (`queue_jobs`) |
| Read replicas — strategies + unreachable | ✓ | Real Postgres (`read_replica_resolve`)                                    | Real HTTP (`replicas_strategies`)          |
| Audit logs (append-only triggers) | ✓ | Real Postgres triggers (`audit_log_service`)                              | —                                          |
| Telemetry / OpenTelemetry        | ✓ | `InMemorySpanExporter` + `AsyncLocalStorageContextManager` (`telemetry_export`) | —                                          |
| Cross-tenant isolation (load-bearing) | — | 5 tenants × 20 concurrent writes via real HTTP (`cross_tenant_e2e`)       | Real HTTP across the demo                  |

**Naming convention**: a spec whose name ends in `_real.spec.ts` (or
`*_smoke*`) requires a live external dependency that's normally only
present in CI — Stripe test-mode API key, MinIO container,
mock-oauth2-server. They skip silently (and visibly in the output)
when their env var is missing; CI is configured to provide them.

## CI infrastructure

The `test-integration` job provisions four service containers in
`.github/workflows/ci.yml`:

| Container                                | Role                                                 |
|------------------------------------------|------------------------------------------------------|
| `postgres:16-alpine`                     | Real PG for the whole integration suite              |
| `redis:7-alpine`                         | Real Redis for cache + queue + rate-limit specs      |
| `ghcr.io/navikt/mock-oauth2-server`      | Wire-compliant OIDC for the SSO real-server spec     |
| `minio/minio` (via `docker run -d` step) | S3-compatible store for the BackupService S3 spec    |

The `test-e2e-demo` job additionally brings up `pg_dump`/`pg_restore`
on PATH and a MailCatcher SMTP receiver so the `examples/api` suite
exercises the full backup + mail surfaces.

Coverage (`c8`) is collected separately for the unit and integration
suites and uploaded as a CI artifact. Thresholds in `.c8rc.json` are
report-only at 0; flip `check-coverage: true` and ratchet the lines /
branches numbers up once you've established a baseline you're happy
with.

## Read next

- [Examples/api](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/tree/master/examples/api)
 ; the reference suite is the best read.
