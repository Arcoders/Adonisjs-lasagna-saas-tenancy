import 'reflect-metadata'
import { runIntegrationSuite, guaranteeGlobs } from '@adonisjs-lasagna/satellite-test-kit'

// The AI satellite's integration tier boots through the shared satellite-test-kit
// (the same Ignitor + DDL bootstrap core uses), reusing core's canonical fixture.
// Specs import the AI modules from ../../src so V8/c8 attributes coverage to src/.
// The suite glob is cwd-relative, so it picks up the AI package's own
// tests/**/integration/**.
await runIntegrationSuite({
  fixtureRoot: new URL('../../core/tests/fixtures/', import.meta.url),
  suiteGlobs: guaranteeGlobs().integration,
})
