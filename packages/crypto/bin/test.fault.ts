import 'reflect-metadata'
import { runIntegrationSuite, guaranteeGlobs } from '@adonisjs-lasagna/satellite-test-kit'

// The crypto satellite's fault-injection and chaos tier (@integration/fault_injection).
// It boots through the shared satellite-test-kit (the same Ignitor and real Postgres
// and Redis as the integration tier, reusing core's canonical fixture), but is
// non-gating: these specs inject real mid-operation faults (a KeyProvider backend
// outage, a WORM ledger write that drops before the irreversible delete, a store that
// fails mid rekek walk, a coordination layer that is down), so they are slow and
// deliberately hostile. They run on a [chaos] commit or a schedule, not on every PR.
// Specs import the crypto modules from ../../src (so a chaos run still measures src),
// and `allowEmpty` keeps the tier a clean no-op when nothing here matches.
await runIntegrationSuite({
  fixtureRoot: new URL('../../core/tests/fixtures/', import.meta.url),
  suiteGlobs: guaranteeGlobs().fault,
  allowEmpty: true,
})
