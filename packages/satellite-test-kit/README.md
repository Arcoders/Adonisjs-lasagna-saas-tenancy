# @adonisjs-lasagna/satellite-test-kit

**Private, dev-only. Never published.** (`"private": true`, version `0.0.0`, no
`lasagnaSatellite` manifest, so the publish flow and the satellite graduation gate both
ignore it.)

## Why this exists

The integration suites for core and every satellite need the same things: a booted AdonisJS
`Ignitor` rooted at a fixture app, the backoffice + satellite DDL provisioned on a clean
Postgres, tenant factories, and the *one genuinely fragile bit* — the exit-code recompute that
swallows the benign "Connection terminated" pg teardown race without hiding real failures.

Before this kit, that machinery lived inline in `packages/core/bin/test.integration.ts`.
Copying it into each satellite would mean six divergent copies of the subtlest code in the test
tree, and the next person to fix the race (or bump a Japa behavior) would have to find and fix
all six. **This package owns it once.** Core and each satellite are thin callers.

The deep rationale for the exit-code logic is documented at the top of
`packages/core/bin/test.integration.ts` and mirrored in
[`src/run_integration_suite.ts`](src/run_integration_suite.ts). Read it before touching the
`.finally` recompute.

## Public API

| Export | What it is | When to use it |
|---|---|---|
| `runIntegrationSuite({ fixtureRoot, suiteGlobs? })` | The Ignitor + Japa wiring and the authoritative exit-code recompute. | The whole body of a package's `bin/test.integration.ts`. |
| `ensureBackofficeSchema()` | Idempotent DDL for `backoffice.tenants` + every satellite table (branding, feature flags, webhooks, SSO, metrics, audit logs, billing). | Wired automatically via `runnerHooks.setup`; call directly only for a bespoke runner. |
| `runnerHooks` | `{ setup: [ensureBackofficeSchema], teardown: [] }`. | Passed through by `runIntegrationSuite`. |
| `plugins` | `[assert(), apiClient(), pluginAdonisJS(app)]`. | Passed through by `runIntegrationSuite`. |
| `configureSuite` | Starts the in-process HTTP server for the `integration` suite. | Passed through by `runIntegrationSuite`. |
| `createTestTenant` / `destroyTestTenant` / `updateTenantStatus` | Tenant-row factories against `backoffice.tenants`. | Per-spec setup/teardown of tenants. |
| `setupTestConfig(overrides?)` / `testConfig` | Install a baseline `MultitenancyConfig` into the module-level singleton. | Specs that need config without a full boot. |

## Usage

A satellite's `bin/test.integration.ts` is a one-liner:

```ts
import { runIntegrationSuite } from '@adonisjs-lasagna/satellite-test-kit'

await runIntegrationSuite({
  fixtureRoot: new URL('../tests/fixtures/', import.meta.url),
  suiteGlobs: ['tests/integration/**/*.spec.ts'],
})
```

…and its `package.json` mirrors core's scripts:

```jsonc
"test:integration:run": "tsx bin/test.integration.ts",
"test:integration:coverage": "c8 --check-coverage=false --temp-directory=../../coverage/.v8/<sat>-integration tsx bin/test.integration.ts"
```

Run one satellite's integration suite locally (needs the service stack — see below):

```bash
npm run build:all   # the kit is consumed via its build output
npm run test:integration:coverage --workspace @adonisjs-lasagna/<sat>
```

### CI service containers it expects

Integration runs against real backends, provided by the `test-integration` job in
`.github/workflows/ci.yml` — `postgres:16-alpine`, `redis:7`, `stripe/stripe-mock`,
`ghcr.io/navikt/mock-oauth2-server`, and MinIO (started via `docker run`, because Actions
service containers cannot pass the CMD override MinIO needs). Specs that touch a backend not
present self-skip. There is no test `docker-compose`; the only compose is the local dev one at
`examples/api/docker-compose.yml`.

## The shared-fixture model

`runIntegrationSuite` takes a `fixtureRoot` so the caller chooses the app to boot. The intended
end state is **one canonical fixture** that boots the full provider superset (core + every
satellite); satellites self-skip the providers whose optional peers (`jose`, `socket.io`, an
`adminActorResolver`) are absent. If booting all providers together ever surfaces boot-order
coupling, the documented fallback is composable per-satellite fixtures built from these same kit
primitives — same `runIntegrationSuite`, different `fixtureRoot`.

## Gotchas

- **Cross-package spec resolution.** A satellite's specs live under its own
  `tests/integration/**`, outside the fixture root. `runIntegrationSuite` rewrites the rcFile
  suite globs to the caller's cwd-relative `suiteGlobs` (default
  `tests/integration/**/*.spec.ts`) so they are found while the suite-level `configureSuite`
  hook still applies.
- **`forceExit` is forced OFF.** The fixture's `adonisrc` may set `forceExit: true`; that would
  make Japa `process.exit()` before the `.finally` exit-code recompute runs, turning the whole
  recompute into dead code. The kit overrides it to `false` and exits authoritatively from
  `.finally`.
- **Consumed via build output.** Like the published satellites, this kit is imported by package
  name and resolves to `build/`, so `build:all` must run before any integration suite. It is
  dev-only and must never be published.
