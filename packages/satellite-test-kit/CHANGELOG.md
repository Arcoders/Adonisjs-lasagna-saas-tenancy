# Changelog: @adonisjs-lasagna/satellite-test-kit

This package is private and never published, so it carries no semver. This log records the
cross-cutting changes to the shared integration harness (anything touching `runIntegrationSuite`,
the backoffice/satellite DDL in `bootstrap.ts`, or the `.`/`/testing` entry-point split), because
each one affects the test run of core and every satellite.

## 2026-06-23: harden the harness

- Extracted the fragile decision logic into a pure, dependency-free `src/runner_logic.ts`
  (`isConnectionTerminated`, `deriveSuiteDirectories`, `resolveSpecImport`, `decideExit`) and
  added the kit's first unit suite under `tests/unit/`, behind a self-contained coverage floor.
- `decideExit` now fails loud on zero matched specs (exit 1 plus a diagnostic) instead of
  silently exiting 0. Added `allowEmpty?: boolean` to `RunIntegrationSuiteOptions` as the opt-out.
- Added a boot-safety metatest: it imports the main barrel with no Ignitor and asserts no eager
  file imports an app-dependent `@adonisjs/core|lucid/services/*` module.
- Added a consumer canary in `packages/satellite-template` (a one-spec integration suite that
  boots this harness from a fresh satellite), wired into CI after the satellite integration suites.
- Removed dead code in the suite-directory derivation and added a gated `LASAGNA_TESTKIT_DEBUG`
  trace.

## Baseline: the harness

The kit owns, in one place, what every integration suite needs: a booted AdonisJS `Ignitor`
rooted at a fixture app, the idempotent backoffice and satellite DDL (`ensureBackofficeSchema`),
tenant factories on the `/testing` subpath, and the authoritative exit-code recompute that
swallows the benign "Connection terminated" pg teardown race without hiding real failures. Core
and each satellite are thin callers of `runIntegrationSuite`.
