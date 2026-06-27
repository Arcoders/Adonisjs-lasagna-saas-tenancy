import { test } from '@japa/runner'
import {
  assertRowScopeRlsPresent,
  type RlsCatalogRow,
} from '../../../src/services/isolation/rls_boot_probe.js'
import IsolationConfigException from '../../../src/exceptions/isolation_config_exception.js'

/**
 * WS-5 / rowscope-acknowledgment-flag-no-verification.
 *
 * `rowScopeRls: true` claims RLS is the backstop; this helper proves it. A scoped
 * table must have RLS ENABLED, FORCED, and at least one policy, else boot fails
 * closed (IsolationConfigException).
 *
 * RED (pre-fix): no such helper/probe existed; the flag was unverified.
 */
function row(table: string, over: Partial<RlsCatalogRow> = {}): RlsCatalogRow {
  return { table, rowSecurity: true, forceRowSecurity: true, policyCount: 1, ...over }
}

test.group('assertRowScopeRlsPresent', () => {
  test('passes when every scoped table is enabled + forced + policied', ({ assert }) => {
    assert.doesNotThrow(() =>
      assertRowScopeRlsPresent([row('posts'), row('comments')], ['posts', 'comments'])
    )
  })

  test('throws when a scoped table is missing from the catalog', ({ assert }) => {
    assert.throws(
      () => assertRowScopeRlsPresent([row('posts')], ['posts', 'comments']),
      /comments.*not found|not found.*comments/
    )
  })

  test('throws when RLS is not ENABLED', ({ assert }) => {
    assert.throws(
      () => assertRowScopeRlsPresent([row('posts', { rowSecurity: false })], ['posts']),
      /not ENABLED/
    )
  })

  test('throws when RLS is not FORCED (owner bypass)', ({ assert }) => {
    assert.throws(
      () => assertRowScopeRlsPresent([row('posts', { forceRowSecurity: false })], ['posts']),
      /not FORCED/
    )
  })

  test('throws when there is no policy', ({ assert }) => {
    assert.throws(
      () => assertRowScopeRlsPresent([row('posts', { policyCount: 0 })], ['posts']),
      /no RLS policy/
    )
  })

  test('the failure is an IsolationConfigException (500, deploy-fix-required)', ({ assert }) => {
    try {
      assertRowScopeRlsPresent([row('posts', { rowSecurity: false })], ['posts'])
      assert.fail('expected a throw')
    } catch (err) {
      assert.instanceOf(err, IsolationConfigException)
    }
  })
})
