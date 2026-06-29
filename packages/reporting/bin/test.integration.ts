import 'reflect-metadata'
import { runIntegrationSuite, guaranteeGlobs } from '@adonisjs-lasagna/satellite-test-kit'

// reporting's integration tier boots through the shared satellite-test-kit — the
// same Ignitor + DDL bootstrap (which provisions backoffice.tenant_metrics AND
// backoffice.tenant_custom_metrics) + exit-code recompute core uses. Specs import
// the reporting modules from ../../src so V8/c8 attributes coverage to src/. The
// suite glob is cwd-relative, so it picks up reporting's own tests/integration/**.
await runIntegrationSuite({
  fixtureRoot: new URL('../../core/tests/fixtures/', import.meta.url),
  suiteGlobs: guaranteeGlobs().integration,
})
