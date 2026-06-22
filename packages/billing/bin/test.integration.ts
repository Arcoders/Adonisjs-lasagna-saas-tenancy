import 'reflect-metadata'
import { runIntegrationSuite } from '@adonisjs-lasagna/satellite-test-kit'

// billing's integration tier boots through the shared satellite-test-kit, the same
// Ignitor + DDL bootstrap + exit-code recompute core uses. It reuses core's
// canonical fixture app, which loads the billing provider + commands and mounts the
// Stripe webhook receiver (multitenancyBillingRoutes), so the whole webhook /
// subscription / usage / dunning pipeline runs against real PG/Redis. The real-API
// smoke specs self-skip without their keys; stripe_mock_smoke needs STRIPE_MOCK_HOST.
// The suite glob is cwd-relative, so it picks up billing's own tests/integration/**.
//
// BILLING_OPTIONAL_SMOKES_ONLY=1 narrows the suite to the OPTIONAL/secondary
// provider real-API smokes (live Paddle + Lemon Squeezy). CI runs those in a
// dedicated non-blocking step so a secondary-provider outage can't fail the
// build. Stripe is the primary provider: its real smokes are NOT in this lane —
// they run on the blocking gate as part of the default full-suite run.
const OPTIONAL_SMOKE_GLOBS = [
  'tests/integration/**/paddle_real_smoke.spec.ts',
  'tests/integration/**/lemon_squeezy_real_smoke.spec.ts',
]
const suiteGlobs =
  process.env.BILLING_OPTIONAL_SMOKES_ONLY === '1'
    ? OPTIONAL_SMOKE_GLOBS
    : ['tests/integration/**/*.spec.ts']

await runIntegrationSuite({
  fixtureRoot: new URL('../../core/tests/fixtures/', import.meta.url),
  suiteGlobs,
})
