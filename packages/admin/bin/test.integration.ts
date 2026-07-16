import 'reflect-metadata'
import { runIntegrationSuite, guaranteeGlobs } from '@adonisjs-lasagna/satellite-test-kit'

// admin's integration tier boots through the shared satellite-test-kit, the same
// Ignitor + DDL bootstrap + exit-code recompute core uses. It reuses core's
// canonical fixture app, which mounts the admin REST + OpenAPI routes
// (multitenancyAdminRoutes) and wires the satellite controllers, so the admin
// endpoints run against real PG/Redis. The suite glob is cwd-relative, so it
// picks up admin's own tests/integration/** specs.
await runIntegrationSuite({
  fixtureRoot: new URL('../../core/tests/fixtures/', import.meta.url),
  suiteGlobs: guaranteeGlobs().integration,
})
