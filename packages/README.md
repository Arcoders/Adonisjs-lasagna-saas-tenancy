# Packages

The monorepo's workspaces. `core` is the multitenancy kernel; everything else is
optional and builds on the public SDK it exposes.

| Package | npm | What it is |
|---|---|---|
| [`core`](core) | `@adonisjs-lasagna/saas-tenancy` | The kernel: schema-per-tenant isolation, resolution, provisioning, the plugin platform. |
| [`billing`](billing) | `@adonisjs-lasagna/billing` | Multi-provider billing (Stripe / Paddle / Lemon Squeezy). |
| [`backup`](backup) | `@adonisjs-lasagna/backup` | Per-tenant backup, restore, clone, SQL import. |
| [`sso`](sso) | `@adonisjs-lasagna/sso` | Per-tenant OIDC / SSO. |
| [`reporting`](reporting) | `@adonisjs-lasagna/reporting` | Cross-tenant analytics over the backoffice metrics tables. |
| [`ai`](ai) | `@adonisjs-lasagna/ai` | Per-tenant AI streaming gateway with per-chunk cost metering. |
| [`admin`](admin) | not published | REST admin API + OpenAPI + Swagger. Lives here; vendor it or use a git dependency. |
| [`websockets`](websockets) | not published | Multi-tenant socket.io. Lives here; vendor it or use a git dependency. |
| [`satellite-template`](satellite-template) | not published | A runnable reference satellite. Copy it to start your own. |
| [`satellite-test-kit`](satellite-test-kit) | not published | Dev-only shared test harness (one Ignitor, one DDL bootstrap). |
| [`doc-coverage`](doc-coverage) | not published | Dev-only code-to-docs drift engine behind `npm run docs:doctor`. |

## Writing a satellite

Copy `satellite-template`. The contract you build against is core's `/sdk` subpath
and the `lasagnaSatellite` manifest in your `package.json`; core's `configure`
discovers installed satellites through it and publishes their migrations.

## Adding a workspace

Four places must move together or CI breaks:

1. `packages/<name>/package.json` (with `lasagnaSatellite` if it is a satellite).
2. A `build:<name>` script in the root `package.json`, linked into the `build:all` chain.
3. The lockfile: `npm install --package-lock-only --legacy-peer-deps`, committed.
   `scripts/check-lockfile-workspaces.mjs` fails the first CI job otherwise.
4. A row in `docs/reference/stability.md` and a docs landing page, unless the
   package is `private`.

Set `"private": true` on anything you do not intend to publish. Several guards
(`check-stability-versions`, `check-satellite-coverage`, `public_api_documented`)
key off that field and skip private packages, and `changeset publish` refuses them.
