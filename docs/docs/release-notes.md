---
title: Release notes
description: Auto-generated from CHANGELOG.md. The canonical changelog lives in the repo root.
---

# Release notes

> Auto-generated from
> [`CHANGELOG.md`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/CHANGELOG.md)
> at build time. The repo file is canonical.

All notable changes to `@adonisjs-lasagna/saas-tenancy` are documented here.

This project adheres to [Semantic Versioning](https://semver.org/).

---

## [0.1.0] — 2026-05-03

First v2 beta. Pluggable isolation drivers, hardened DDL paths, strict
tenant scope by default. Migration guide at
[/docs/migrating-v1-to-v2](/docs/migrating-v1-to-v2).

### Added — Block A (foundations)

- `TenantRepositoryContract.each(callback, opts)` — cursor-paginated iteration
  for memory-safe walks across N tenants.
- `BootstrapperRegistry` with `enter` / `leave` / `runScoped` lifecycle
  primitives. `runScoped(ctx, fn)` unwinds partial-enter on failure and
  always runs `leave` on `fn` throw.
- `tenancy.run(tenant, fn)` / `tenancy.currentId()` / `tenancy.current()`
  — canonical API for activating tenant context outside HTTP. Wraps
  `TenantLogContext` (AsyncLocalStorage) and the bootstrapper registry.
- `cacheBootstrapper` + `tenantCache()` helper — first concrete
  bootstrapper. Per-tenant BentoCache namespaces with an injectable
  factory for hermetic unit tests.

### Added — Block B (driver system)

- `IsolationDriver` interface — `provision` / `destroy` / `reset` /
  `connect` / `disconnect` / `connectionName` / `migrate`.
- `SchemaPgDriver` — current schema-per-tenant behavior, factored out of
  the v1 inline logic.
- `DatabasePgDriver` — database-per-tenant on PG. Idempotent provision,
  `pg_terminate_backend` before `DROP DATABASE`. Requires `CREATEDB`.
- `RowScopePgDriver` — shared schema with `tenant_id` column. Destroy is
  `DELETE FROM <table> WHERE tenant_id = ?` per configured table; migrate
  is a no-op.
- `withTenantScope(BaseModel)` mixin — Lucid `before('find'|'fetch'|
  'paginate'|'create'|'update'|'delete')` hooks inject `WHERE tenant_id`
  from `tenancy.currentId()` and reject cross-tenant writes. Escape via
  `unscoped(fn)`.
- `IsolationDriverRegistry` — `register` / `use` / `active` / `get` /
  `has` / `list` / `clear`. Provider seeds the active driver from
  `config.isolation.driver`.
- `tenant:migrate:fresh` ace command — DROP + recreate per-tenant storage
  and re-run migrations. `--seed` runs `db:seed` after each tenant.

### Added — security hardening

- `assertSafeIdentifier()` — rejects anything that could escape a quoted
  PG identifier (`"`, `;`, whitespace, shell metacharacters, length
  > 63). Called at every driver entry that interpolates `tenant.id` into
  DDL.
- `MissingTenantScopeException` + strict scope mode (default) — querying
  a `withTenantScope` model outside both `tenancy.run()` and
  `unscoped()` now throws instead of silently returning every tenant's
  rows. Opt-out via `isolation.rowScopeMode: 'allowGlobal'`.
- Bulk `Model.query().delete()` / `.update()` are now scoped via the
  `before('fetch')` hook (Lucid fires it for query-builder paths). v1's
  silent cross-tenant wipe vector is closed.
- `provider.shutdown()` invalidates module-level singleton caches in
  `tenancy.ts` and `active_driver.ts` so test runners and hot-reload
  paths can no longer hold references to dead containers.
- `spawn('psql', …)` no longer uses `shell: true` on Windows. Eliminates
  the cmd.exe metacharacter interpretation surface.

### Changed (BREAKING)

- `TenantAdapter` constructor now requires an `IsolationDriverRegistry`:
  `new TenantAdapter(db, drivers)`. The bundled provider does this for
  you; only custom providers need updating.
- `IsolationDriver.connectionName(tenant)` → `connectionName(tenantId:
  string)`. Synchronous callers (the adapter) only need the id.
- `TenantModelContract` no longer declares `getConnection`,
  `closeConnection`, `install`, `uninstall`, `migrate`,
  `dropSchemaIfExists`, or `invalidateCache`. The active driver owns
  these. Delete them from your tenant model.
- `withTenantScope` defaults to **strict** scope. v1 silent-passthrough
  is now `isolation.rowScopeMode: 'allowGlobal'`.
- 14 internal call sites (commands, jobs, services, request macro, read
  replicas, sql_import_service, clone_service) refactored to use
  `getActiveDriver()` instead of tenant-model methods. No user-facing
  change unless you wrapped these.
- Lifecycle status transitions (`provisioning` / `active` / `failed` and
  `deletedAt`) moved from the user's tenant model into the
  `InstallTenant` / `UninstallTenant` jobs.
- Node 24 required at runtime (the package's `engines` field already
  said this; v2 surfaces dependency code paths that need it).

### Migration

See [/docs/migrating-v1-to-v2](/docs/migrating-v1-to-v2). For most
apps: add `isolation: { driver: 'schema-pg' }` to the multitenancy
config and delete the deprecated methods from the tenant model.

### Tests

- 334 unit tests passing on Node 24 (was 238 in v1).
- New integration suites for `SchemaPgDriver`, `DatabasePgDriver`,
  `RowScopePgDriver` + `withTenantScope` against real PG.

---

## [1.0.5] — 2026-04-28

### Fixed

- `tenant:import` no longer crashes the host process when the dump contains `COPY … FROM stdin` blocks. The previous attempt at wire-protocol streaming via `pg-copy-streams` failed at runtime on Knex 3 / Lucid 22 because the borrowed transaction client doesn't expose a usable `pg.Client`, so any plain-text `pg_dump` would throw `Invalid connection for transaction query` at the first COPY block. See `multitenancy-1.0.4-verification-report.md` for the field repro.

### Changed

- `tenant:import` now shells out to `psql` when the dump contains COPY blocks, and uses the existing transactional Lucid path only for INSERT-only dumps. The `psql` command must be available on the user's PATH (this is the case for any developer with the PostgreSQL client tools installed).
- `SqlImportResult` now carries a `mode` field: `'transactional'`, `'psql'`, or `'dry-run'`. Useful when reporting which path ran.

### Removed

- `pg-copy-streams` optional peer dependency. It was only there for the v1.0.4 attempt that never worked in any release. Consumers who installed it can uninstall it safely.

---

## [1.0.4] — 2026-04-27

### Fixed

- `tenant:create` now actually dispatches `InstallTenant` after inserting the row. Previously the CLI would log "queued" but no job was ever enqueued, leaving every CLI-created tenant stuck at `status='provisioning'`.
- `tenant:import` now correctly handles `COPY … FROM stdin` blocks, the default format produced by `pg_dump`. Previously the splitter treated each tab-separated data row as its own SQL statement and every row failed with a syntax error, leaving target tables empty.
- The post-create log message now points at `node ace queue:work` (the real command) instead of the non-existent `queue:listen`.
- README's commands section: `tenant:import-sql` corrected to `tenant:import`, and the `tenant:restore` example now makes clear it expects a custom-format archive (`.dump`), not a plain `.sql` file.

### Added

- `pg-copy-streams` as an optional peer dependency. Required only when importing plain-text `pg_dump` files that contain `COPY … FROM stdin` blocks. If absent, `tenant:import` fails fast with a clear remediation message.
- `splitSqlStatementsTagged()` in `src/utils/sql_splitter.ts`. Tokenizes SQL into `{ kind: 'sql' }` and `{ kind: 'copy', header, rows }` units so callers can route COPY blocks through the wire-protocol streaming path.
- `SqlImportResult` now reports `copyBlocksExecuted` and `copyRowsImported` alongside the per-statement counters.

---

## [1.0.3] — 2026-04-27

### Changed

- README now opens with a Lasagna ASCII banner, tagline, and status badges (Node.js, AdonisJS, PostgreSQL, Redis, tests, license)

---

## [1.0.2] — 2026-04-26

### Added

- MIT `LICENSE` file (© Ismael Haytam Tanane)
- `CONTRIBUTING.md` with setup, test, and PR workflow guidance
- `package.json` metadata: `author`, `homepage`, `repository`, `bugs`, `keywords`

### Changed

- `license` field switched from `UNLICENSED` to `MIT`
- README License section now points to the new `LICENSE` file
- README gained a Contributing section linking to `CONTRIBUTING.md`

---

## [1.0.1] — 2026-04-25

### Fixed

- `src/commands/commands.json` had a stray `]` at line 234 that closed the commands array early, leaving `tenant:webhooks:retry` and `tenant:metrics:flush` outside the array and breaking JSON parsing on install

---

## [1.0.0] — 2026-04-21

### Added

- **Core**
  - `MultitenancyProvider` — registers adapters, sets config, boots `request.tenant()` macro
  - `resolveTenantId()` — extracts tenant identifier via `header`, `subdomain`, or `path` strategy
  - `TENANT_REPOSITORY` symbol — DI token for `TenantRepositoryContract`
  - `getConfig()` / `setConfig()` — config accessor used across services

- **Base models**
  - `BackofficeBaseModel` — Lucid base for backoffice schema models
  - `TenantBaseModel` — Lucid base for tenant-scoped models (per-schema adapter)
  - `CentralBaseModel` — Lucid base for the central/public schema

- **Adapters**
  - `DefaultLucidAdapter` — standard Lucid adapter pass-through
  - `BackofficeAdapter` — forces schema search path for backoffice connection
  - `TenantAdapter` — dynamically routes queries to the correct tenant schema

- **Middleware**
  - `TenantGuardMiddleware` — resolves tenant from request, throws on missing/invalid
  - `CustomDomainMiddleware` — maps custom hostnames to tenant identifiers
  - `RateLimitMiddleware` — per-tenant rate limiting via Redis

- **Services**
  - `CircuitBreakerService` — per-tenant opossum circuit breakers
  - `TenantQueueService` — per-tenant BullMQ queues with stats
  - `TelemetryService` — OpenTelemetry span/counter helpers
  - `BackupService` — `pg_dump`/`pg_restore` with optional S3 upload
  - `CloneService` — schema-level tenant cloning
  - `SqlImportService` — raw SQL import with statement splitting
  - `AuditLogService` — structured audit trail per tenant
  - `FeatureFlagService` — per-tenant feature flags with percentage rollout
  - `WebhookService` — outbound webhooks with delivery tracking and retries
  - `BrandingService` — per-tenant branding (logo, colors)
  - `SsoService` — per-tenant SSO config (OIDC/SAML metadata)
  - `MetricsService` — time-series metrics storage per tenant

- **Satellite models** (backoffice schema)
  - `TenantAuditLog`, `TenantFeatureFlag`, `TenantWebhook`, `TenantWebhookDelivery`
  - `TenantBranding`, `TenantSsoConfig`, `TenantMetric`

- **Events**
  - `TenantCreated`, `TenantActivated`, `TenantSuspended`

- **Jobs** (BullMQ)
  - `InstallTenant`, `UninstallTenant`, `CloneTenant`, `BackupTenant`, `RestoreTenant`

- **Commands** (17 Ace commands)
  - `backoffice:setup`, `tenant:create`, `tenant:list`, `tenant:activate`, `tenant:suspend`
  - `tenant:destroy`, `tenant:migrate`, `tenant:migrate-rollback`, `tenant:run-migrations`
  - `tenant:rollback-migrations`, `tenant:seed`, `tenant:backup`, `tenant:backup:list`
  - `tenant:restore`, `tenant:clone`, `tenant:import-sql`, `tenant:queue:stats`

- **Exceptions**
  - `MissingTenantHeaderException` (400), `TenantNotFoundException` (404)
  - `TenantSuspendedException` (403), `TenantNotReadyException` (503)
  - `CircuitOpenException` (503)

- **configure hook** — `node ace configure @adonisjs-lasagna/saas-tenancy`
  - Registers provider + commands in `adonisrc.ts`
  - Publishes `config/multitenancy.ts` from stub
  - Scaffolds `app/models/backoffice/tenant.ts` if absent

- **Stubs**
  - `stubs/config/multitenancy.stub`
  - `stubs/models/tenant.stub`

- **Utilities**
  - `encrypt()` / `decrypt()` / `isEncrypted()` — field-level encryption helpers
  - `splitSqlStatements()` — splits multi-statement SQL for safe import
  - LRU cache utility for tenant resolution

---

[1.0.5]: https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/releases/tag/v1.0.5
[1.0.4]: https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/releases/tag/v1.0.4
[1.0.3]: https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/releases/tag/v1.0.3
[1.0.2]: https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/releases/tag/v1.0.2
[1.0.1]: https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/releases/tag/v1.0.1
[1.0.0]: https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/releases/tag/v1.0.0
