import 'reflect-metadata'
import { runIntegrationSuite, guaranteeGlobs } from '@adonisjs-lasagna/satellite-test-kit'

// The crypto satellite's integration tier boots through the shared satellite-test-kit
// (the same Ignitor and DDL bootstrap core uses), reusing core's canonical fixture.
// Specs import the crypto modules from ../../src so V8/c8 attributes coverage to
// src/, and construct the real services (PgWrappedDekStore, CryptoService, the shared
// WormLedgerWriter) against the booted app's real Postgres. The suite glob is
// cwd-relative, so it picks up crypto's own tests/@guarantees/**/integration/**.
await runIntegrationSuite({
  fixtureRoot: new URL('../../core/tests/fixtures/', import.meta.url),
  suiteGlobs: guaranteeGlobs().integration,
})
