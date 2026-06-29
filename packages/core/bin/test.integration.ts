import 'reflect-metadata'
import { runIntegrationSuite, guaranteeGlobs } from '@adonisjs-lasagna/satellite-test-kit'

// The Ignitor wiring, the suite-glob rewrite, and the fragile exit-code recompute
// (the benign "Connection terminated" pg teardown race) all live in the shared
// satellite-test-kit so core and every satellite run the identical boot path.
// See packages/satellite-test-kit/README.md and src/run_integration_suite.ts.
// Core keeps its own route-rich fixture; the kit owns the harness + the
// backoffice/satellite DDL bootstrap (ensureBackofficeSchema).
await runIntegrationSuite({
  fixtureRoot: new URL('../tests/fixtures/', import.meta.url),
  suiteGlobs: guaranteeGlobs().integration,
})
