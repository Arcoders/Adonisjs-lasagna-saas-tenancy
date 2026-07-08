import 'reflect-metadata'
import { runIntegrationSuite, guaranteeGlobs } from '@adonisjs-lasagna/satellite-test-kit'

// sso's integration tier boots through the shared satellite-test-kit, the same
// Ignitor + DDL bootstrap + exit-code recompute core uses. It reuses core's
// canonical fixture app (the de-facto shared fixture: it boots the multitenancy
// provider, so the BackofficeAdapter that backs TenantSsoConfig is wired, plus a
// real PG/Redis). sso ships only a backstop provider (it asserts ABI + plugin-API
// at boot and binds nothing); this suite constructs SsoService directly and never
// registers it, so no fixture extension is needed. The suite glob is cwd-relative,
// so it picks up sso's own tests/integration/** specs.
await runIntegrationSuite({
  fixtureRoot: new URL('../../core/tests/fixtures/', import.meta.url),
  suiteGlobs: guaranteeGlobs().integration,
})
