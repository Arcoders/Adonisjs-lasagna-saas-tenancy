import { test } from '@japa/runner'
import {
  assertRowScopeRlsPresent,
  type RlsCatalogRow,
} from '../../../../src/services/isolation/rls_boot_probe.js'
import IsolationConfigException from '../../../../src/exceptions/isolation_config_exception.js'

/**
 * WS-5 / rowscope-acknowledgment-flag-no-verification.
 *
 * `rowScopeRls: true` claims RLS is the backstop; this helper proves it. A scoped
 * table must have RLS ENABLED, FORCED, at least one policy, AND a NOT NULL scoped
 * column, else boot fails closed (IsolationConfigException).
 */
function row(table: string, over: Partial<RlsCatalogRow> = {}): RlsCatalogRow {
  return {
    table,
    rowSecurity: true,
    forceRowSecurity: true,
    policyCount: 1,
    scopeColumnNotNull: true,
    ...over,
  }
}

const COL = 'tenant_id'

test.group('assertRowScopeRlsPresent', () => {
  test('passes when every scoped table is enabled + forced + policied + NOT NULL', ({ assert }) => {
    assert.doesNotThrow(() =>
      assertRowScopeRlsPresent([row('posts'), row('comments')], ['posts', 'comments'], COL)
    )
  })

  test('throws when a scoped table is missing from the catalog', ({ assert }) => {
    assert.throws(
      () => assertRowScopeRlsPresent([row('posts')], ['posts', 'comments'], COL),
      /comments.*not found|not found.*comments/
    )
  })

  test('throws when RLS is not ENABLED', ({ assert }) => {
    assert.throws(
      () => assertRowScopeRlsPresent([row('posts', { rowSecurity: false })], ['posts'], COL),
      /not ENABLED/
    )
  })

  test('throws when RLS is not FORCED (owner bypass)', ({ assert }) => {
    assert.throws(
      () => assertRowScopeRlsPresent([row('posts', { forceRowSecurity: false })], ['posts'], COL),
      /not FORCED/
    )
  })

  test('throws when there is no policy', ({ assert }) => {
    assert.throws(
      () => assertRowScopeRlsPresent([row('posts', { policyCount: 0 })], ['posts'], COL),
      /no RLS policy/
    )
  })

  test('throws when the scoped column is nullable (or missing)', ({ assert }) => {
    assert.throws(
      () => assertRowScopeRlsPresent([row('posts', { scopeColumnNotNull: false })], ['posts'], COL),
      /nullable or missing|NOT NULL/
    )
  })

  test('the NOT NULL failure names the scoped column', ({ assert }) => {
    assert.throws(
      () =>
        assertRowScopeRlsPresent(
          [row('posts', { scopeColumnNotNull: false })],
          ['posts'],
          'org_id'
        ),
      /org_id/
    )
  })

  test('the failure is an IsolationConfigException (500, deploy-fix-required)', ({ assert }) => {
    try {
      assertRowScopeRlsPresent([row('posts', { rowSecurity: false })], ['posts'], COL)
      assert.fail('expected a throw')
    } catch (err) {
      assert.instanceOf(err, IsolationConfigException)
    }
  })
})
