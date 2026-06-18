# Satellite extraction (B3) — migration runbook

Status: **all four extracted (`@adonisjs-lasagna/admin`, `@adonisjs-lasagna/sso`,
`@adonisjs-lasagna/billing`, `@adonisjs-lasagna/backup`).** This directory holds
the extracted satellite packages. The runbook is the executable plan so each move
is mechanical and verifiable. It is a breaking change, sequenced for the `1.0.0` cut.

The four extractions are done and verified locally (build core->sso->billing->admin->backup,
typecheck, core unit 488 + billing unit + backup unit 41, coverage gate, npm-pack,
runtime resolution). The fixture wiring + integration/e2e specs resolve the new
packages (proven via `require.resolve`) but only fully run in CI
(Postgres/Redis/Stripe). Billing + backup additionally moved provider wiring + ace
commands; that **provider lifecycle is CI-verified only**. See the "DONE" sections
at the end.

## Why

The core package is ~18.7k LOC and bundles a full Stripe billing engine, SSO,
and a REST admin API alongside the actual tenancy primitives. That couples
unrelated release cadences and blast radius: a CVE in the Stripe path forces a
core bump, and the surface is large for one maintainer. Splitting the optional
satellites into their own packages shrinks the core, lets satellites version
independently, and lets consumers install only what they use.

## Boundary

**Core stays** `@adonisjs-lasagna/saas-tenancy`: isolation drivers + registry,
`TenantAdapter`/base models, resolvers + registry, `tenancy` + contextual
logging, the guard/central middleware, health, doctor (base checks), quotas +
plans, circuit breaker, resilience, hooks, bootstrappers, lifecycle events,
jobs, exceptions, testing helpers.

**Extract to packages:**

| Package | Modules |
|---|---|
| `@adonisjs-lasagna/billing` | `services/billing*`, `services/billing/**`, `controllers/stripe_webhook_controller`, `middleware/verify_stripe_webhook_middleware`, `jobs/process_stripe_event_job`, billing events/listeners, `testing/billing/**` |
| `@adonisjs-lasagna/sso` | `services/sso_service`, `models/satellites/tenant_sso_config`, SSO admin controller bits |
| `@adonisjs-lasagna/admin` | `admin/**` (REST + OpenAPI + Swagger) |
| `@adonisjs-lasagna/backup` (optional) | `services/backup_service`, `backup_retention_service`, `clone_service`, `sql_import_service`, backup commands |

## Coupling audit (decides the order)

Each satellite imports core via relative paths today; after extraction those
become imports from `@adonisjs-lasagna/saas-tenancy` (and its subpaths).

The targets to extract are `admin`, `sso`, `billing`, `backup`. The leaf
satellites (`branding`, `feature-flags`, `metrics`, `webhooks`, `audit`,
`quotas`) **stay in core** for now.

The only forbidden edge is `core -> satellite-package`. The audit of who, in
core, imports each target decides the order:

- **`admin`** is a pure consumer: it imports `QuotaService`, `BrandingService`,
  `MetricsService`, `FeatureFlagService`, `SsoService`, `WebhookService`,
  `AuditLogService`, `ImpersonationService`, `DoctorService`,
  `TenantQueueService`, `InstallTenant`, six lifecycle events,
  `getActiveDriver`, and the satellite models — but **nothing in core imports
  `admin`** (verified) once one misplaced edge is removed (see below). So
  `admin` extracts **first**: `admin-package -> core` is allowed, and removing
  `admin` from core deletes the biggest cluster of core's satellite imports,
  which unblocks the rest.
- **`sso`**: in core, only `admin` imports `SsoService`. After `admin` leaves,
  nothing in core imports `sso`, so it extracts next.
- **`billing`**: core imports it from the provider (`#wireBillingListeners`,
  shutdown drain) and listeners. Needs inversion of control — the billing
  package should self-register its listeners via its own provider against core
  events/hooks, instead of core wiring billing. Extract after `sso`.
- **`backup`**: core imports it from the backup ace commands and the doctor
  `backup_recency_check`. Move the commands with the package and have the doctor
  check resolve `BackupService` through the container (not a static import).

Reachability check (done): everything `admin/**` consumes is already exported
from a public subpath (`/services` re-exports `DoctorService`,
`TenantQueueService`, `ImpersonationService`, `AuditLogService`, the satellite
services; `/jobs`, `/events`, `/models/satellites`, and the root export the
rest). So the extraction needs little-to-no widening of the core public API —
verify per package and add any missing symbol to `src/index.ts` /
`src/services/index.ts` + the `exports` map + `typesVersions`.

### Severed edge (done): `sso_service -> admin/helpers`

`SsoService` (core) imported `validateExternalHttpsUrl` from
`admin/controllers/helpers.ts` — a `core -> admin` edge that would have made the
`admin` extraction circular. Fixed: the SSRF guard moved to `src/utils/url.ts`
(core), exported from the root, and re-exported from `admin/controllers/helpers`
so the admin controllers are unchanged. Verified (typecheck + 569 unit + build).
This was the only code edge from core into `admin`.

## The circular-dependency rule

A satellite depends on core. If core then re-exported satellite symbols by
*importing* the satellite package, that is a build cycle. So:

> **Core never imports a satellite package.**

The old core subpaths (`/admin`, billing service exports, etc.) become
**deprecated throwing shims** that do not import the satellite — they throw a
clear "moved to `@adonisjs-lasagna/<name>`; `npm i` it and update the import"
error (and are dropped in the next major). This preserves a helpful failure
without re-introducing the cycle.

## Per-package procedure

1. `packages/<name>/` with its own `package.json` (name, `exports`,
   `peerDependencies` including `@adonisjs-lasagna/saas-tenancy` and the
   relevant AdonisJS peers), `tsconfig.json` (extends the root, `outDir
   ./build`), and `README.md`.
2. Move the modules from `src/**` into `packages/<name>/src/**`.
3. Rewrite their imports: core-relative (`../../config.js`) →
   `@adonisjs-lasagna/saas-tenancy` / `/services` / `/types` / `/events` /
   `/jobs` / `/models/satellites`. Add any missing core export.
4. Replace the vacated core subpath with a deprecated throwing shim (see rule
   above) and remove the now-dead `exports`/`typesVersions` entry at the major.
5. Add `packages/*` to the root `workspaces` (first package only).
6. Update the configure command / stubs so `--with=billing|sso|admin` installs
   and wires the new package.

## Verification (per package, before moving on)

- `npm run typecheck` at the root and `tsc --noEmit` in the package.
- `npm run build` for core and the package; confirm `exports`/`typesVersions`
  resolve (`node -e "require.resolve(...)"` / a tiny import smoke).
- Move the package's specs alongside it; run them. Integration that needs
  Postgres/Redis runs in CI (local lacks them).
- `npm pack --dry-run` per package: `files` ships only `build` (+ `stubs`).

## Release sequencing

All of B3 lands in `1.0.0` with a migration guide and a CHANGELOG "BREAKING"
section per moved subpath. Ship the leaf packages first behind a `1.0.0-rc`,
then billing, then admin. Keep the throwing shims for one minor; drop them in
`2.0.0`.

## Order of execution

1. **`admin`** — **DONE** (`@adonisjs-lasagna/admin`). Nothing in core imports
   it (the helper edge was severed first); removing it deleted most
   core->satellite edges.
2. **`sso`** — **DONE** (`@adonisjs-lasagna/sso`). Core edges severed (REPL +
   the three barrels). `admin` now depends on `sso` (admin -> sso -> core).
3. **`billing`** — **DONE** (`@adonisjs-lasagna/billing`). Provider IoC inverted
   into the package's own provider; webhook route + ace commands moved; barrels
   + health module split.
4. **`backup`** — **DONE** (`@adonisjs-lasagna/backup`). The `backup_recency`
   doctor check is registered into the core `DoctorService` by the package's own
   provider; the backup jobs are registered with the queue Locator the same way.

Leaf satellites (`branding`, `feature-flags`, `metrics`, `webhooks`, `audit`,
`quotas`) stay in core.

## First extraction (`admin`) — DONE

Moved to `@adonisjs-lasagna/admin` (`packages/admin`). What was done:

1. `packages/admin/{package.json,tsconfig.json,README.md}`; `packages/*` added
   to the root `workspaces`. The package's `tsconfig.json` extends the root and
   overrides `outDir`/`rootDir`/`include`; `exports` `.` -> `./build/src/index.js`.
2. `git mv` of `admin_controller.ts`, `routes.ts`, `openapi.ts`,
   `swagger_html.ts` and `controllers/*.ts` into `packages/admin/src/`.
   `index.ts` was recreated in the package (the old core `src/admin/index.ts`
   became the shim, see 4).
3. Core imports rewritten to package subpaths, with the **default->named flip**:
   `import QuotaService from '../../services/quota_service.js'` ->
   `import { QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'`.
   Same for `/events`, `/jobs`, `/models/satellites`, `/types`, and
   `getActiveDriver`/`DoctorService`/`ImpersonationService`/`HookRegistry`/
   `TenantQueueService` (`/services`). `validateExternalHttpsUrl` is re-exported
   in `helpers.ts` from the core root (`@adonisjs-lasagna/saas-tenancy`).
   Internal admin imports (`./controllers/*`, `./openapi.js`, `./helpers.js`)
   stayed relative. `routes.ts`, `openapi.ts`, `swagger_html.ts` had no
   core-relative imports.
4. Core `src/admin/index.ts` is now a deprecated **throwing** shim
   (`moved to @adonisjs-lasagna/admin`). The `./admin` export + `typesVersions`
   entry stay one minor, then drop at the next major. The core never imports the
   package, so no cycle.
5. Specs/wiring: `tests/unit/admin/helpers.spec.ts` -> `tests/unit/utils/url.spec.ts`
   (it tests the core `src/utils/url.ts` util now). `tests/unit/admin/openapi.spec.ts`
   repointed to `../../../packages/admin/src/openapi.js` (transitional: a core
   unit spec testing the package's source so it keeps running with no new test
   infra; move it into `packages/admin/tests/` when the package gets its own
   runner). `tests/fixtures/start/routes.ts`, `tests/integration/admin/satellites.spec.ts`,
   and `examples/api/start/routes.ts` import `multitenancyAdminRoutes` from
   `@adonisjs-lasagna/admin`.
6. **Build hygiene fix (needed by the extraction):** core `build` now uses
   `tsconfig.build.json` (only `src` + `index.ts` + `configure.ts`). The old
   `build` compiled `tests/**`, which after the move pulled the package import
   into the core build (chicken-and-egg) and emitted `build/packages` +
   `build/tests` into the published tarball. `typecheck` still uses the full
   `tsconfig.json` (it validates tests). Bonus: the core tarball no longer ships
   compiled tests.
7. Scripts/CI: `build:admin` + `build:all`; `test:integration[:coverage]` run
   `build:all`. CI builds the admin package in lint-and-typecheck (so it is
   typechecked) and uses `build:all` for the e2e + coverage-report jobs. `npm
   install` already has `packages/*` in `workspaces`, so it symlinks
   `@adonisjs-lasagna/admin`.

### Verified locally (Node 24)

`npm run build` (core, clean — no `build/tests`/`build/packages`), `npm run
build:admin` (clean — every subpath import resolves against the core `.d.ts`),
`npm install` (symlinks `node_modules/@adonisjs-lasagna/admin` ->
`packages/admin`), `npm run typecheck` (0 errors), `npm run test:coverage` (569
pass; gate 34.9 lines / 75.96 branches / 62.61 functions, exit 0). Smokes:
`require.resolve('@adonisjs-lasagna/admin')` -> the built package; the package's
`openapi.js` lists 28 paths; the core admin shim throws the migration error.
`npm pack --dry-run`: core ships only the 4 shim files under
`build/src/admin/` (no `tests/`, no `packages/`); admin ships its `build` +
README + package.json (52 files, 42 kB).

### CI-only (not runnable locally — no Postgres/Redis)

The admin **integration** spec (`tests/integration/admin/satellites.spec.ts`)
and the fixture wiring exercise `@adonisjs-lasagna/admin` over HTTP against a
real DB. Module resolution is proven (`require.resolve`), but the full
round-trip runs only in the `test-integration` + `test-e2e-demo` CI jobs.

## Second extraction (`sso`) — DONE

Moved to `@adonisjs-lasagna/sso` (`packages/sso`): `SsoService` + the
`TenantSsoConfig` model. Unlike admin, `sso` was never a dedicated subpath — it
was exported from **shared barrels**, so there is no throwing shim; the symbols
are simply **removed** from the barrels (a documented breaking change).

1. `packages/sso/{package.json,tsconfig.json,README.md}`; `src/index.ts` exports
   `SsoService`, `TenantSsoConfig`, and the `IdTokenClaims` type. `jose` is an
   optional peer.
2. `git mv src/services/sso_service.ts` and
   `src/models/satellites/tenant_sso_config.ts` into `packages/sso/src/`.
   Rewrites: the model -> `./tenant_sso_config.js` (internal); `getCache` ->
   `@adonisjs-lasagna/saas-tenancy/services`; `validateExternalHttpsUrl` ->
   `@adonisjs-lasagna/saas-tenancy` (root); `BackofficeBaseModel` ->
   `@adonisjs-lasagna/saas-tenancy/base-models`.
3. **Severed core -> sso edges:** (a) `src/commands/tenant_repl.ts` no longer
   imports/preloads `SsoService` (the REPL keeps the leaf satellites, drops
   `sso`); (b) `SsoService` removed from `src/index.ts` + `src/services/index.ts`;
   (c) `TenantSsoConfig` removed from `src/index.ts` +
   `src/models/satellites/index.ts`. Verified: no other core file imports them.
4. **Consumers repointed to `@adonisjs-lasagna/sso`:** the admin package's
   `sso_controller` (and `@adonisjs-lasagna/sso` added to admin's
   `peerDependencies` — `admin -> sso -> core`); the three core SSO integration
   specs (`sso_service`, `sso_oidc_flow`, `sso_oidc_real`); the demo
   `sso_controller` + the demo `satellites` e2e spec; `examples/api/package.json`
   gains `file:` deps on the new packages.
5. **Migration moved out of core (done).** `create_tenant_sso_configs_table.stub`
   now lives in `packages/sso/stubs/migrations/`; the package declares a
   `lasagnaSatellite` manifest + an `adonisjs.configure` hook. The core
   `configure.ts` `sso: [...]` bundle is gone. `--with=sso` still works: core
   discovers the installed package via its manifest `aliases` and copies its
   migration through the shared `@adonisjs-lasagna/saas-tenancy/sdk`
   toolkit. (Per-package configure hooks: **shipped** — see
   `docs/cookbook/creating-a-satellite`.)
6. **Build order:** `build:sso` added; `build:all` is now core -> sso -> admin
   (admin imports the sso package). CI's lint-and-typecheck builds sso then admin.

### Verified locally (Node 24)

`npm install` (symlinks `@adonisjs-lasagna/sso`), `npm run build:all` (core ->
sso -> admin, all clean — sso resolves the core subpaths, admin resolves the sso
`.d.ts`), `npm run typecheck` (0 errors — the repointed integration specs
resolve `@adonisjs-lasagna/sso`), `npm run test:coverage` (569 pass; gate **35.53
lines / 76.08 branches / 62.80 functions**, exit 0 — lines ticked up since the
unit-uncovered `sso_service` left core's `src`). Smokes:
`require.resolve('@adonisjs-lasagna/sso')` -> the built package; core barrels
(`build/src/index.d.ts`, `/services`, `/models/satellites`) no longer name
`SsoService`/`TenantSsoConfig`; `npm pack` for sso ships its `build` (8.5 kB).

### CI-only

The three SSO integration specs + the demo e2e exercise `@adonisjs-lasagna/sso`
against a real DB / OIDC server (`mock-oauth2-server`). Resolution is proven;
the round-trip runs in the `test-integration` + `test-e2e-demo` jobs.

## Third extraction (`billing`) — DONE

Moved to `@adonisjs-lasagna/billing` (`packages/billing`). The largest and most
coupled one: ~36 files (the 754-LOC `BillingService`, `services/billing/**`, the
webhook controller + middleware, the Stripe jobs incl. `report_usage_batch_job`,
the three billing listeners, the 10 `events/billing/**`, `BillingException`,
`billing_health_check`, the four Stripe models, `testing/billing/**`, and the six
`tenant:billing:*` commands). The package mirrors the core `src/` subtree, so
billing<->billing relative imports stayed valid; only imports of core-resident
modules were rewritten.

1. **Provider IoC inverted.** The core provider used to register `BillingService`,
   `verify()` on boot, `#wireBillingListeners` on start (quota / usage / tenant-delete),
   and drain the metering aggregator on shutdown. All of that moved verbatim into
   `packages/billing/providers/billing_provider.ts`, which also registers the
   billing jobs with the @adonisjs/queue Locator (core's job auto-register no
   longer sees them). The core provider now references nothing billing. Apps
   register `@adonisjs-lasagna/billing/provider` alongside the core provider.
2. **Webhook route + commands moved.** `multitenancyBillingRoutes` was carved out
   of `src/health/routes.ts` into `packages/billing/src/routes.ts`. The six ace
   commands moved with their own `commands.json` + a `main.ts` loader; the package
   declares `adonisjs.commands` and an `./commands` export. Apps register
   `@adonisjs-lasagna/billing/commands`.
3. **Barrels + health split.** Removed billing symbols from the core `services`,
   `events`, `exceptions`, `jobs`, `middleware`, `models/satellites`, `commands`,
   `testing`, and `health` barrels + `commands.json` (breaking; no shim possible
   for shared barrels). `health/index` keeps `multitenancyRoutes` only.
4. **Types stay in core.** `src/types/billing.ts` + `MultitenancyConfig.billing`
   stay in core, so `config.billing` is still typed; only the runtime moved.
   Billing reads config via a new lightweight `@adonisjs-lasagna/saas-tenancy/config`
   subpath (importing it from the root barrel crashes outside an app — the root
   and `/services` barrels eagerly touch `app.booted`).
5. **Migrations moved out of core (done).** The four `create_billing_*.stub`
   files (plus the `quota_warning` mailer/view) now live in
   `packages/billing/stubs/`; the package declares a `lasagnaSatellite` manifest
   (`requires: ["quotas"]` for `tenant_plans`, which stays in core) + an
   `adonisjs.configure` hook. The core `billing: [...]` bundle is gone.
   `--with=billing` resolves the installed package via its manifest alias and
   copies its migrations through the shared satellite toolkit.
6. **Package-local unit runner.** The six billing unit specs moved to
   `packages/billing/tests/unit/` with a `bin/test.ts` + `test` script, run from
   the package cwd (tsx then picks up the package tsconfig so the Lucid-model
   decorators transform). They can't stay in the core suite: loading the package
   source from the repo-root tsx run trips the decorator transform.
7. **Build hygiene.** All `build` scripts now `rm -rf build` first — `tsc` doesn't
   prune, so post-move stale `.js` (billing/admin/sso) were leaking into the core
   tarball. Build order: core -> sso -> billing -> admin.

### Verified locally (Node 24)

`npm install` (symlinks `@adonisjs-lasagna/billing`), `npm run build:all` (core ->
sso -> billing -> admin, all clean), `npm run typecheck` (0 errors — the ~25
repointed billing integration specs + fixture `adonisrc`/routes resolve the
package), `npm run test:coverage` (**529 pass**; gate raised to **40 lines / 74
branches / 62 functions**, measured **43.08 / 77.57 / 65.61**, exit 0 — coverage
jumped since the unit-uncovered billing left core `src`), and the package's own
`npm run test --workspace @adonisjs-lasagna/billing` (**40 pass**). Smokes:
`require.resolve` of `@adonisjs-lasagna/billing` + `/provider` + `/commands`;
`commands.json` ships in the build; core `.d.ts` barrels name no billing symbol;
the core tarball ships only the intentional `types/billing.*` (the billing
migration stubs have since moved into `packages/billing/stubs/` — see item 5).

### CI-only (the elevated-risk part)

The ~25 billing **integration** specs (dunning, webhook idempotency, IP allowlist,
PII redaction, metered usage, the command specs, etc.) exercise the webhook
pipeline + the **provider lifecycle** against real Postgres/Redis/Stripe. The
provider IoC was moved verbatim, but boot/start/shutdown wiring + the fixture
registering `@adonisjs-lasagna/billing/provider` + `/commands` only actually run
in the `test-integration` + `test-e2e-demo` jobs. A wiring mistake there would
not be caught by the local build/typecheck/unit gates.

## Fourth extraction (`backup`) — DONE

Moved to `@adonisjs-lasagna/backup` (`packages/backup`): the four backup-domain
services (`BackupService` 284 LOC, `BackupRetentionService`, `CloneService`,
`SqlImportService`), the three queue jobs (`BackupTenant`, `RestoreTenant`,
`CloneTenant`), the `backup_recency` doctor check, and the six ace commands
(`tenant:backup`, `tenant:backup:list`, `tenant:restore`, `tenant:import`,
`tenant:clone`, `tenant:backups:run`). Mirrored `src/` subtree, so intra-package
relative imports (jobs/commands/doctor -> `../services/*`) stayed valid; only the
core-resident imports were rewritten.

1. **What stays in core (the lifecycle contract).** `backup`/`restore`/`clone`
   are first-class tenant-lifecycle phases in the core `HookRegistry`, and the
   `TenantBackedUp` / `TenantRestored` / `TenantCloned` events sit alongside the
   other lifecycle events. So those stay in core, as does the `backup` config
   block. The two result types the contract carries (`BackupMetadata`,
   `CloneResult`) moved to a new `src/types/backup.ts` (same pattern as
   `types/billing.ts`): the core defines them, the package imports + re-exports
   them. `hook_registry` and the two events were repointed to `../types/backup.js`.
2. **Doctor check inverted via the existing extension API.** `DoctorService` already
   had `register()` / `unregister()`. So `backup_recency_check` moved into the
   package (`src/doctor/`), was removed from the core `builtInChecks` +
   `checks/index` + `doctor/index` + `services/index`, and the package's provider
   registers it into the core `DoctorService` on `boot()`. The check keeps its
   direct `new BackupService()` (both now in the package); the core doctor has zero
   backup knowledge.
3. **Provider + jobs.** `packages/backup/providers/backup_provider.ts` registers the
   doctor check (boot) and the three jobs with the @adonisjs/queue Locator (start) —
   the core `#registerQueueJobs` no longer sees them (its `jobs/index` dropped the
   three). Apps register `@adonisjs-lasagna/backup/provider` + `/commands`.
4. **New `@adonisjs-lasagna/saas-tenancy/internal` subpath.** The package's unit
   specs load service modules outside a booted app, so they cannot import core
   helpers through `/services` or the root barrel (those touch `app.booted`). A new
   leaf subpath `internal` (backed by `src/internal.ts`) re-exports the
   app.booted-safe building blocks the satellites need: `assertSafeIdentifier`,
   `getActiveDriver`, `splitSqlStatementsTagged`, and `buildTestTenant`. Documented
   as not part of the stable app-facing API. `getConfig` keeps coming from the
   existing `/config` subpath.
5. **Barrels + root.** Removed the four services + their package-only types from
   `services/index`; removed the three jobs (+ `CloneTenantPayload`) from
   `jobs/index`; removed all of those from the root `index.ts`, but kept
   `BackupMetadata` / `CloneResult` exported there sourced from `/types`. The six
   commands left `commands/index` + `commands.json` (a fresh `commands.json` + a
   `main.ts` loader live in the package; `tenant:doctor` stays in core).
6. **`@aws-sdk/client-s3`** is now an optional peer of the package (it stays an
   optional peer + devDep of the core too, matching how billing/sso left their
   optional peers). Migration: backup had no migration stub and was never a
   `--with=` option, so nothing migration-side changed.
7. **Package-local unit runner.** The five backup unit specs moved to
   `packages/backup/tests/unit/` with a `bin/test.ts`; `backup_retention` pulls
   `buildTestTenant` from `/internal` and a package-local `tests/helpers/config.ts`.

### Verified locally (Node 24)

`npm install` (symlinks `@adonisjs-lasagna/backup`), `npm run build:all` (core ->
sso -> billing -> admin -> backup, all clean), `npm run typecheck` (0 errors — the
repointed backup integration/e2e specs resolve the package), `npm run test:coverage`
(**488 pass**; gate raised to **44 lines / 76 branches / 65 functions**, measured
**46.39 / 78 / 67.57**, exit 0 — coverage rose since the unit-uncovered backup left
core `src`), and the package's own `npm run test --workspace @adonisjs-lasagna/backup`
(**41 pass**). Smokes: `require.resolve` of `@adonisjs-lasagna/backup` + `/provider`
+ `/commands` + `/internal`; importing `/internal` with no booted app loads cleanly;
core `.d.ts` barrels name no backup service/job/check; the core tarball ships only
`types/backup.*` (no stale `.js`); the backup tarball is build-only (75 files). CI
now also runs the billing + backup package unit suites (a gap from the billing
extraction).

### CI-only

The backup integration specs (`backup_s3`, `clone_service`, `doctor_checks_real`,
`lifecycle_dispatch`) + the demo e2e (`backups_real`, `commands_lifecycle`, `full`)
exercise the services, the jobs, the `backup_recency` check, and the
`tenant:backup*` / `tenant:clone` / `tenant:import` commands against real
Postgres/Redis/S3. The provider registering the check + jobs only runs in the
`test-integration` + `test-e2e-demo` jobs.
