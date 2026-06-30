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

## Test layout (organized by guarantee)

Tests are organized by the **guarantee** they protect, not by the machinery that
runs them. Every package's `tests/` shows the same skeleton:

```
tests/@guarantees/<g>/{unit,integration}/   # <g> = isolation | security | behavior | resilience | performance
tests/@architecture/{boundaries,contracts,docs}/   # static guards (no DB); docs/ holds the *_documented integrity specs
tests/@integration/drivers/                 # driver specs gated on every integration run
tests/helpers/                              # shared, non-spec support
```

The harness (unit vs integration) is the **leaf** inside each guarantee, because
the two run in different worlds: unit specs run against source with `tsx` and no
database, integration specs boot a real `Ignitor` + PostgreSQL against the
compiled build. A runner therefore selects only the specs it can run with one
recursive glob, while a maintainer still finds "everything about isolation" in
one place.

All five guarantees and both harness leaves are present in every package, so the
tree reads the same everywhere. A slot with no specs yet carries a short
`README.md` so the directory is tracked and self-documenting; run
`npm run scaffold:tests` to materialize the skeleton for a new package. The chaos
tier (`@integration/fault_injection`) and the fixture app (`tests/fixtures`) live
only in core, because no satellite has its own fault runner or Ignitor fixture.
`examples/api` keeps the full-scenario suite under `tests/@integration/e2e/`
(plus `hardening/`) and is the demo's only tier.

Naming follows `<guarantee>_<context>_<outcome>.spec.ts` for guarantee specs;
architectural and integration-dimension specs keep their existing descriptive
names. Every package ships a `@architecture/boundaries/<pkg>_guarantee_tree` spec
that calls the kit's `assertGuaranteeTree`, which fails if a directory under
`@guarantees/` is not a canonical guarantee, if a harness leaf is anything but
`unit` or `integration`, or if a stray directory appears at the top level. The
taxonomy is single-sourced in the kit, so adding a guarantee or tier is one edit
there and nothing else can drift.

## The `/testing` subpath

```ts
import {
  buildTestTenant,
  MockTenantRepository,
  setRequestTenant,
  withTenant,
} from '@adonisjs-lasagna/saas-tenancy/testing'
```

The barrel is safe to import in a hermetic unit test: it does not
boot a database connection at import time.

## In-memory doubles

When a service is defined as an interface, an in-memory
implementation lets you exercise it with no database: the "second
implementation that proves the abstraction" pattern the billing
satellite uses with its `MockBillingDriver`. The pattern needs no
shared base class; a small id-keyed `Map` does the job. The
[satellite template](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/tree/master/packages/satellite-template)
ships a tiny, copyable `InMemoryStore` helper
(`src/testing/in_memory_store.ts`) and a `WidgetStore` double built on
it. See [Creating a satellite](/guides/cookbook/creating-a-satellite)
for the full walkthrough.

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

The lifecycle floor still applies to the memo: a seeded tenant whose status is
`suspended` (or that is soft-deleted) makes `request.tenant()` throw the same
403 it would in production; call `request.tenant({ allowInactive: true })` in
tests that exercise inactive tenants on purpose.

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

## Swapping a bootstrapper for tests

There is no factory config for bootstrappers. The supported seam is
the registry itself: the provider only registers a built-in
bootstrapper when no bootstrapper with that name exists yet, so a
test (or a test-only provider) that registers its own first wins:

```ts
import { BootstrapperRegistry } from '@adonisjs-lasagna/saas-tenancy/services'

const registry = await app.container.make(BootstrapperRegistry)
registry.unregister('drive')
registry.register({
  name: 'drive',
  enter: () => {/* point tenantDisk paths at a temp dir, stub a client, … */},
})
```

For database-shaped tests, prefer the `sqlite-memory` isolation
driver: real SQL round-trips with zero infrastructure.

## Integration tests against real PostgreSQL

The package's own test suite runs integration tests against real
Postgres. Patterns to copy:

- `bin/test.integration.ts`; boots a real `Ignitor` rooted at the
  fixture app, hands the runner to `app.testRunner()`.
- `tests/fixtures/`; a minimal AdonisJS app that imports the
  package via the `exports` map.
- `examples/api/`; a complete reference app whose e2e suite lives
  under `tests/@integration/e2e/` (with a `hardening/` subfolder for
  the security and resilience scenarios).

The reference suite uses `examples/api/docker-compose.yml` to bring
up Postgres, Redis, and MailCatcher; everything Lasagna integrates
with; `npm run test:e2e` wraps the whole cycle.

## Integration test harness (`@adonisjs-lasagna/satellite-test-kit`)

The core and every satellite share one dev-only harness,
`@adonisjs-lasagna/satellite-test-kit`, so the Ignitor boot, schema DDL, and exit-code
recompute live in a single place instead of being copy-pasted into each package's
`bin/test.integration.ts`. It is never published; depend on it as a dev dependency.

The kit also single-sources the guarantee taxonomy and the suite globs
(`GUARANTEES`, `guaranteeGlobs()`) and a thin unit runner (`runUnitSuite`), so a
package's runners collapse to a couple of lines:

```ts
// bin/test.ts (unit harness: @guarantees/**/unit + @architecture, against source)
import { runUnitSuite } from '@adonisjs-lasagna/satellite-test-kit'
runUnitSuite({ withArchitecture: true }) // every package runs its own @architecture tree guard

// bin/test.integration.ts (stack harness: real Ignitor + PostgreSQL)
import { runIntegrationSuite, guaranteeGlobs } from '@adonisjs-lasagna/satellite-test-kit'
await runIntegrationSuite({
  fixtureRoot: new URL('../../core/tests/fixtures/', import.meta.url),
  suiteGlobs: guaranteeGlobs().integration,
})
```

The per-tenant lifecycle helpers live on the `/testing` subpath, so a spec can provision a
real tenant schema and tear it down without reaching into the core:

```ts
import {
  createTestTenant,
  destroyTestTenant,
  updateTenantStatus,
  setupTestConfig,
} from '@adonisjs-lasagna/satellite-test-kit/testing'

setupTestConfig() // install the shared test config so services resolve consistently
const tenant = await createTestTenant() // real schema, ready to query
await updateTenantStatus(tenant.id, 'suspended')
await destroyTestTenant(tenant.id)
```

`createTestTenant` / `destroyTestTenant` differ from [`buildTestTenant`](#buildtesttenant):
`buildTestTenant` returns an in-memory object for unit tests, while these create and drop a
**real** tenant schema for integration tests.

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
| Billing — Stripe / Paddle / Lemon Squeezy | ✓ | `MockStripe` + deterministic per-driver tests incl. reconciliation (`paddle_driver`, `lemon_squeezy_driver`); **real Stripe** smokes (`stripe_real_smoke` + Test Clocks for renewal/dunning, soft-skipping Stripe-side infra); opt-in Paddle/LS real smokes (skip without secrets) | Real webhook receiver |
| Webhooks outbound (HMAC/retry)   | ✓ | Real HTTP receiver in-spec (`webhook_service`)                            | Real HTTP (`webhooks_delivery`)            |
| Queue jobs (`InstallTenant`, `UninstallTenant`, `ProcessBillingEventJob`, …) | ✓ | Inline dispatch (`webhook_idempotency`)                                   | **Real `queue:work` subprocess** (`queue_jobs`) |
| Read replicas — strategies + unreachable | ✓ | Real Postgres (`read_replica_resolve`)                                    | Real HTTP (`replicas_strategies`)          |
| Audit logs (append-only triggers) | ✓ | Real Postgres triggers (`audit_log_service`)                              | —                                          |
| Telemetry / OpenTelemetry        | ✓ | `InMemorySpanExporter` + `AsyncLocalStorageContextManager` (`telemetry_export`) | —                                          |
| Cross-tenant isolation (load-bearing) | — | 5 tenants × 20 concurrent writes via real HTTP (`cross_tenant_e2e`)       | Real HTTP across the demo                  |

**Naming convention**: a spec whose name ends in `_real.spec.ts` (or
`*_smoke*`) requires a live external dependency that's normally only
present in CI: a Stripe test-mode API key, a MinIO container, or
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
