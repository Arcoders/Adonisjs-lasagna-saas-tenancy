import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * WS-5 / rowscope-acknowledgment-flag-no-verification (anti-regression lock).
 *
 * The boot probe only protects anyone if the isolation installer (the provider's
 * boot-phase slice for isolation) actually runs it when `rowScopeRls === true`.
 * This pins that wiring so a refactor can't drop it back to trusting the flag. The
 * probe's DECISION is unit-tested in rls_boot_probe.spec.ts.
 *
 * RED (pre-fix): the isolation wiring never referenced the probe.
 */
const PROVIDER = fileURLToPath(
  new URL('../../../src/providers/installers/isolation_wiring.ts', import.meta.url)
)

test.group('architectural — rowscope RLS boot probe is wired', () => {
  test('the provider verifies rowScopeRls via probeRlsCatalog + assertRowScopeRlsPresent', ({
    assert,
  }) => {
    const src = readFileSync(PROVIDER, 'utf8')
    assert.match(src, /rowScopeRls === true/, 'the probe must gate on rowScopeRls === true')
    assert.match(src, /probeRlsCatalog\(/, 'the provider must query the RLS catalog')
    assert.match(src, /assertRowScopeRlsPresent\(/, 'the provider must assert the probe result')
    // WS-5: the scoped column must be threaded through so the probe can assert it
    // is NOT NULL (a nullable scoped column is a latent isolation hole).
    assert.match(
      src,
      /rowScopeColumn\s*\?\?\s*'tenant_id'/,
      'the provider must resolve the scope column and pass it to the probe'
    )
  })

  test('detector controls: the matcher is not vacuously true', ({ assert }) => {
    assert.match('await assertRowScopeRlsPresent(rows, tables)', /assertRowScopeRlsPresent\(/)
    assert.notMatch('await somethingElse(rows)', /assertRowScopeRlsPresent\(/)
  })
})
