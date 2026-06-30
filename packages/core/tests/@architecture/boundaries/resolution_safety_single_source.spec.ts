import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * WS-3: resolution-safety speaks with one voice. Two high-severity cross-tenant
 * exposures (the membership-gate IDOR and the unbounded host-trust) must be
 * detected AND enforced from a single function, `resolutionSafetyAudit`, so a
 * future change cannot make the boot warning, the doctor check, and the
 * production hard-fail disagree about what is unsafe.
 *
 * This lock asserts all three consumers derive from `resolutionSafetyAudit`, and
 * that the production hard-fail in `assertConfigBounds` is actually wired
 * (guarded by `isProductionNodeEnv()` and a `throw`), not merely computed.
 */

const file = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const read = (rel: string) => readFileSync(file(rel), 'utf8')

const AUDIT = /resolutionSafetyAudit\s*\(/

test.group('architectural — resolution safety is single-sourced', () => {
  test('the boot warning, the doctor check, and the bounds check all derive from resolutionSafetyAudit', ({
    assert,
  }) => {
    assert.match(
      read('../../../src/providers/multitenancy_provider.ts'),
      AUDIT,
      'provider boot warning must derive from resolutionSafetyAudit'
    )
    assert.match(
      read('../../../src/services/doctor/checks/membership_gate_check.ts'),
      AUDIT,
      'the membership_gate doctor check must derive from resolutionSafetyAudit'
    )
    assert.match(
      read('../../../src/providers/assert_config_bounds.ts'),
      AUDIT,
      'the production bounds check must derive from resolutionSafetyAudit'
    )
  })

  test('assertConfigBounds hard-fails in production on any finding', ({ assert }) => {
    const src = read('../../../src/providers/assert_config_bounds.ts')
    // The audit must run under a production guard and a finding must throw.
    assert.match(
      src,
      /isProductionNodeEnv\(\)[\s\S]{0,400}?resolutionSafetyAudit\s*\([\s\S]{0,200}?throw\s+new\s+Error/,
      'production boot must throw on a non-empty resolutionSafetyAudit result'
    )
  })

  test('detector controls: the matcher is not vacuously true', ({ assert }) => {
    assert.match('resolutionSafetyAudit(config)', AUDIT)
    assert.notMatch('someOtherAudit(config)', AUDIT)
  })
})
