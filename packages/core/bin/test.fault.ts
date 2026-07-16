import { runIntegrationSuite, guaranteeGlobs } from '@adonisjs-lasagna/satellite-test-kit'

// Fault-injection / chaos tier (@integration/fault_injection): real PG/Redis via
// the shared Ignitor harness, but NON-GATING: run on a schedule or a [chaos]
// commit, not on every PR (these specs are slow and deliberately destructive).
// allowEmpty so a package with no chaos specs is a clean no-op pass.
await runIntegrationSuite({
  fixtureRoot: new URL('../tests/fixtures/', import.meta.url),
  suiteGlobs: guaranteeGlobs().fault,
  allowEmpty: true,
})
