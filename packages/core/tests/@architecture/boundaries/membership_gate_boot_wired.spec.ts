import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * WS-4 / membership-idor-gate-opt-in-no-runtime-signal.
 *
 * A client-controlled resolver strategy with no `authorizeTenantAccess` is a
 * cross-tenant IDOR that, before this fix, produced ZERO runtime signal. The
 * robust fix logs one WARN at provider boot (and exposes the same verdict via
 * the `membership_gate` doctor check). This anti-regression lock proves the
 * boot wiring stays in place: the provider must consult `membershipGateRisk`
 * and route a non-null verdict to `bootLogger?.warn(...)`.
 *
 * RED (pre-fix): the provider never references `membershipGateRisk`.
 */

const PROVIDER = fileURLToPath(
  new URL('../../../src/providers/multitenancy_provider.ts', import.meta.url)
)

test.group('architectural — membership-gate boot warning is wired', () => {
  test('provider boot consults membershipGateRisk and warns on a non-null verdict', ({
    assert,
  }) => {
    const src = readFileSync(PROVIDER, 'utf8')
    assert.match(
      src,
      /membershipGateRisk\s*\(/,
      'provider must call membershipGateRisk(config) at boot'
    )
    // The verdict must reach the logger, not be computed and dropped.
    assert.match(
      src,
      /idorWarning[\s\S]{0,200}?bootLogger\?\.warn\(\s*idorWarning\s*\)/,
      'a non-null membership-gate verdict must be logged via bootLogger.warn'
    )
  })

  test('detector controls: the matcher is not vacuously true', ({ assert }) => {
    // Positive control: a string that should match.
    assert.match('const x = membershipGateRisk(config)', /membershipGateRisk\s*\(/)
    // Negative control: an unrelated call must not satisfy the matcher.
    assert.notMatch('const x = somethingElse(config)', /membershipGateRisk\s*\(/)
  })
})
