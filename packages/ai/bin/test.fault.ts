import 'reflect-metadata'
import { runIntegrationSuite, guaranteeGlobs } from '@adonisjs-lasagna/satellite-test-kit'

// The AI satellite's fault-injection and chaos tier (@integration/fault_injection).
// It boots through the shared satellite-test-kit (the same Ignitor and real Postgres
// and Redis as the integration tier, reusing core's canonical fixture), but is
// non-gating: these specs inject real mid-flight faults into the tool loop (a
// provider that drops mid tool_use, a tool handler whose database is unreachable, a
// Redis outage on a round's rate limit, a client that disconnects while a tool runs),
// so they are slow and deliberately hostile. They run on a [chaos] commit or a
// schedule, not on every PR. Specs import the AI modules from ../../src (so a chaos
// run still measures src), and `allowEmpty` keeps the tier a clean no-op when nothing
// here matches.
await runIntegrationSuite({
  fixtureRoot: new URL('../../core/tests/fixtures/', import.meta.url),
  suiteGlobs: guaranteeGlobs().fault,
  allowEmpty: true,
})
