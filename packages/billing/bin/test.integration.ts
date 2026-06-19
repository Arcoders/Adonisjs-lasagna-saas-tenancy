import 'reflect-metadata'
import { runIntegrationSuite } from '@adonisjs-lasagna/satellite-test-kit'

// billing's integration tier boots through the shared satellite-test-kit, the same
// Ignitor + DDL bootstrap + exit-code recompute core uses. It reuses core's
// canonical fixture app, which loads the billing provider + commands and mounts the
// Stripe webhook receiver (multitenancyBillingRoutes), so the whole webhook /
// subscription / usage / dunning pipeline runs against real PG/Redis. The real-API
// smoke specs self-skip without their keys; stripe_mock_smoke needs STRIPE_MOCK_HOST.
// The suite glob is cwd-relative, so it picks up billing's own tests/integration/**.
await runIntegrationSuite({
  fixtureRoot: new URL('../../core/tests/fixtures/', import.meta.url),
  suiteGlobs: ['tests/integration/**/*.spec.ts'],
})
