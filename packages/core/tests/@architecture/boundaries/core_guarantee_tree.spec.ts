import { test } from '@japa/runner'
import { assertGuaranteeTree } from '../../../../satellite-test-kit/src/guarantee_tree.js'

/**
 * Anti-drift guard for this package's guarantee-oriented test tree. The
 * guarantee a spec belongs to is encoded in its PATH
 * (`tests/@guarantees/<g>/<harness>/`), and the runners + `test:guarantee`
 * filter on that path, so a typo'd directory or a stray legacy `unit/` at the
 * top level would silently fall out of every view. The validation is
 * single-sourced in the kit's `assertGuaranteeTree`, pinned against the taxonomy
 * constants there, so adding a guarantee, tier, or top-level dir is one edit in
 * `guarantees.ts` and nothing else can drift.
 *
 * Reads directories only (no Ignitor, no DB), so it runs in the unit harness.
 * Every package ships this same 3-line caller against its own `tests/` root.
 */

const TESTS_ROOT = new URL('../../', import.meta.url)

test.group('Architecture: guarantee tree', () => {
  test('the tree matches the single-sourced taxonomy', ({ assert }) => {
    assertGuaranteeTree(TESTS_ROOT, assert)
  })
})
