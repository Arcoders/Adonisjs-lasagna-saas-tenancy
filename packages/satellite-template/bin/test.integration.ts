import 'reflect-metadata'
import { runIntegrationSuite } from '@adonisjs-lasagna/satellite-test-kit'

// Consumer canary: boot the shared integration harness from a fresh, minimal
// satellite, reusing core's fixture. This proves @adonisjs-lasagna/satellite-test-kit
// (the Ignitor boot, the backoffice DDL bootstrap, the /testing helpers, and the
// exit-code recompute) still works for a real consumer. A kit change that breaks
// a downstream satellite fails here, isolated and fast, instead of buried in a
// satellite's full suite. See packages/satellite-test-kit/README.md.
await runIntegrationSuite({
  fixtureRoot: new URL('../../core/tests/fixtures/', import.meta.url),
  suiteGlobs: ['tests/integration/**/*.spec.ts'],
})
