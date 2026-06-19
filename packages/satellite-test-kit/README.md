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

## Public API — two entry points, split on boot-time safety

The kit has **two** entry points, and which one you import matters (see the boot-ordering
gotcha below):

**`@adonisjs-lasagna/satellite-test-kit`** — the runner. SAFE to import before the app boots
(a `bin/test.integration.ts` imports it at the top level, before the Ignitor exists).

| Export | What it is | When to use it |
|---|---|---|
| `runIntegrationSuite({ fixtureRoot, suiteGlobs? })` | The Ignitor + Japa wiring and the authoritative exit-code recompute. | The whole body of a package's `bin/test.integration.ts`. |

**`@adonisjs-lasagna/satellite-test-kit/testing`** — tenant/config helpers. Import these from
your **spec files** (which load after the app boots), never from a `bin` entry: they pull in
`@adonisjs/lucid/services/db`, which is only safe post-boot.

| Export | What it is | When to use it |
|---|---|---|
| `createTestTenant` / `destroyTestTenant` / `updateTenantStatus` | Tenant-row factories against `backoffice.tenants`. | Per-spec setup/teardown of tenants. |
| `setupTestConfig(overrides?)` / `testConfig` | Install a baseline `MultitenancyConfig` into the module-level singleton. | Specs that need config without a full boot. |

**Internal (not exported):** `ensureBackofficeSchema()` (idempotent DDL for `backoffice.tenants`
+ every satellite table), `runnerHooks`, `plugins`, `configureSuite`. The runner loads these
**lazily** via a dynamic `import('./bootstrap.js')` inside `.configure()` — i.e. after boot,
because they import `@adonisjs/core/services/{app,test_utils}`, whose module bodies run
`await app.booted(...)` and crash when `app` is still undefined.

## Usage

A satellite's `bin/test.integration.ts` is a one-liner:

```ts
import { runIntegrationSuite } from '@adonisjs-lasagna/satellite-test-kit'

await runIntegrationSuite({
  fixtureRoot: new URL('../tests/fixtures/', import.meta.url),
  suiteGlobs: ['tests/integration/**/*.spec.ts'],
})
```

…and its `package.json` scripts point tsx at the **root** tsconfig:

```jsonc
"test:integration:run": "tsx --tsconfig ../../tsconfig.json bin/test.integration.ts",
"test:integration:coverage": "c8 --check-coverage=false --temp-directory=../../coverage/.v8/<sat>-integration tsx --tsconfig ../../tsconfig.json bin/test.integration.ts"
```

**Why `--tsconfig ../../tsconfig.json` is mandatory (do not drop it).** A satellite boots
core's canonical fixture, whose Lucid models use legacy (`experimentalDecorators`) decorators.
tsx/esbuild applies a tsconfig's `experimentalDecorators` only to files **inside that
tsconfig's directory tree**; the fixture lives under `packages/core/...`, outside the
satellite's tree, so the satellite's own tsconfig does not cover it and esbuild rejects the
decorators with `Decorators are not valid here`. The repo-root tsconfig's tree spans the whole
monorepo (it covers both the fixture and the satellite's specs) and sets
`experimentalDecorators: true`, so pointing tsx at it transforms everything correctly. (Core's
own integration run needs no flag: its cwd tsconfig already contains the fixture.)

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

- **Import the runner from `.`, helpers from `/testing` — never mix them.** The `bin` entry
  runs before the Ignitor exists, so it must import ONLY `runIntegrationSuite`. Importing a
  helper (or the old all-in-one barrel) from a `bin` transitively loads
  `@adonisjs/core/services/test_utils`, whose module body runs `await app.booted(...)` and
  throws `Cannot read properties of undefined (reading 'booted')` because `app` is still
  undefined. This is exactly the failure that split the entry points. Specs import `/testing`;
  they load after boot, where `services/db` etc. are safe.
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
