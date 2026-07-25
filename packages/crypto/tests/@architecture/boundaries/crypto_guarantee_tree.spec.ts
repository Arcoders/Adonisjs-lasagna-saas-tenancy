import { test } from '@japa/runner'
import { assertGuaranteeTree } from '../../../../satellite-test-kit/src/guarantee_tree.js'

/**
 * Anti-drift guard for this package's guarantee-oriented test tree. The
 * validation is single-sourced in the kit's assertGuaranteeTree, pinned against
 * the taxonomy constants there, so the layout cannot drift unnoticed. Every
 * package ships this same caller against its own tests/ root, which is what keeps
 * the skeleton uniform across the monorepo.
 *
 * Reads directories only (no Ignitor, no DB), so it runs in the unit harness.
 */

const TESTS_ROOT = new URL('../../', import.meta.url)

test.group('Architecture: guarantee tree', () => {
  test('the tree matches the single-sourced taxonomy', ({ assert }) => {
    assertGuaranteeTree(TESTS_ROOT, assert)
  })
})
