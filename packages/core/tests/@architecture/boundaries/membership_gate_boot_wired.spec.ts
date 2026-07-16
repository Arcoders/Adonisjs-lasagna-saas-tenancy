import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * WS-4 / membership-idor-gate-opt-in-no-runtime-signal, kept current through
 * WS-3 (resolution-safety single source).
 *
 * A client-controlled resolver strategy with no `authorizeTenantAccess` is a
 * cross-tenant IDOR that, before this fix, produced ZERO runtime signal. The
 * robust fix logs one WARN at provider boot (and exposes the same verdict via
 * the `membership_gate` doctor check + a fail-closed hard-fail). All three derive
 * from `resolutionSafetyAudit`. This anti-regression lock proves the boot wiring
 * stays in place: the resolution installer (the provider's boot-phase slice for
 * tenant resolution) must consult `resolutionSafetyAudit` and route each finding's
 * message to the logger (deferred to app.booted so a warning is never silently
 * dropped).
 *
 * RED (pre-fix): the resolution wiring never references `resolutionSafetyAudit`.
 */

const PROVIDER = fileURLToPath(
  new URL('../../../src/providers/installers/resolution_wiring.ts', import.meta.url)
)

test.group('architectural — resolution-safety boot warning is wired', () => {
  test('provider boot consults resolutionSafetyAudit and warns on each finding', ({ assert }) => {
    const src = readFileSync(PROVIDER, 'utf8')
    assert.match(
      src,
      /resolutionSafetyAudit\s*\(/,
      'provider must call resolutionSafetyAudit(config) at boot'
    )
    // Each finding's message must reach the logger, not be computed and dropped.
    assert.match(
      src,
      /resolutionRisks[\s\S]{0,300}?logger\.warn\(risk\.message\)/,
      'each resolution-safety finding must be logged via logger.warn'
    )
  })

  test('detector controls: the matcher is not vacuously true', ({ assert }) => {
    assert.match('const x = resolutionSafetyAudit(config)', /resolutionSafetyAudit\s*\(/)
    assert.notMatch('const x = somethingElse(config)', /resolutionSafetyAudit\s*\(/)
  })
})
