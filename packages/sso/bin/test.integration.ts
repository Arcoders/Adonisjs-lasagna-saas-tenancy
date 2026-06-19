import 'reflect-metadata'
import { runIntegrationSuite } from '@adonisjs-lasagna/satellite-test-kit'

// sso's integration tier boots through the shared satellite-test-kit, the same
// Ignitor + DDL bootstrap + exit-code recompute core uses. It reuses core's
// canonical fixture app (the de-facto shared fixture: it boots the multitenancy
// provider, so the BackofficeAdapter that backs TenantSsoConfig is wired, plus a
// real PG/Redis). sso has no provider of its own (SsoService is constructed
// directly), so no fixture extension is needed. The suite glob is cwd-relative,
// so it picks up sso's own tests/integration/** specs.
await runIntegrationSuite({
  fixtureRoot: new URL('../../core/tests/fixtures/', import.meta.url),
  suiteGlobs: ['tests/integration/**/*.spec.ts'],
})
