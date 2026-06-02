# Satellite extraction (B3) — migration runbook

Status: **scaffolding / not started in code.** This directory will hold the
extracted satellite packages. Nothing is moved yet; this runbook is the
executable plan so each move is mechanical and verifiable. It is a breaking
change, sequenced for the `1.0.0` cut.

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

- **Leaf satellites** (`branding`, `feature-flags`, `metrics`, `audit`,
  `webhooks`, `sso`): depend only on core (config, types, base models, events,
  a satellite model). Cleanest. **Extract first.**
- **`billing`**: depends on core (config, types, `QuotaService`, events,
  `MetricsService`, mailer) but not on `admin`. Extract after the leaves.
- **`admin`**: the REST facade over *every* satellite. `admin/**` imports
  `QuotaService`, `BrandingService`, `MetricsService`, `FeatureFlagService`,
  `SsoService`, `WebhookService`, `AuditLogService`, `ImpersonationService`,
  `DoctorService`, `TenantQueueService`, `InstallTenant`, six lifecycle events,
  `getActiveDriver`, and the satellite models. **Extract last**, after the
  satellites it consumes are packages (or it depends on them as packages).

Reachability check (done): everything `admin/**` consumes is already exported
from a public subpath (`/services` re-exports `DoctorService`,
`TenantQueueService`, `ImpersonationService`, `AuditLogService`, the satellite
services; `/jobs`, `/events`, `/models/satellites`, and the root export the
rest). So the extraction needs little-to-no widening of the core public API —
verify per package and add any missing symbol to `src/index.ts` /
`src/services/index.ts` + the `exports` map + `typesVersions`.

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

1. `branding`, `feature-flags`, `metrics`, `audit`, `webhooks` (leaves).
2. `sso`.
3. `billing`.
4. `admin` (last).
5. `backup` (independent; any time after the leaves).
