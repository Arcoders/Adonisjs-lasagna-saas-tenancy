import { test } from '@japa/runner'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  ARCHITECTURE_TIERS,
  GUARANTEES,
  HARNESS_LEAVES,
  INTEGRATION_TIERS,
  TOP_LEVEL_DIRS,
} from '../../../../src/guarantees.js'
import { assertGuaranteeTree } from '../../../../src/guarantee_tree.js'

/** A URL ending in a slash, as `assertGuaranteeTree` expects for its tests root. */
function dirUrl(dir: string): URL {
  return pathToFileURL(join(dir, '/'))
}

/** Build a `tests/`-shaped tree from a list of relative directory paths. */
function buildTree(dirs: string[]): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'lasagna-tree-'))
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true })
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** An `assert` double that records each `deepEqual` call instead of throwing. */
function capturingAssert() {
  const calls: { actual: unknown; expected: unknown }[] = []
  return {
    calls,
    assert: {
      deepEqual(actual: unknown, expected: unknown) {
        calls.push({ actual, expected })
      },
    },
  }
}

test.group('structural taxonomy constants', () => {
  test('the tier and leaf sets are the canonical, non-empty values', ({ assert }) => {
    assert.deepEqual([...HARNESS_LEAVES], ['unit', 'integration'])
    assert.deepEqual([...ARCHITECTURE_TIERS], ['boundaries', 'contracts', 'docs'])
    assert.deepEqual([...INTEGRATION_TIERS], ['drivers', 'fault_injection', 'e2e'])
    assert.deepEqual(
      [...TOP_LEVEL_DIRS],
      ['@guarantees', '@architecture', '@integration', 'helpers', 'fixtures']
    )
  })
})

test.group('assertGuaranteeTree', () => {
  test('passes for a full uniform tree', ({ assert }) => {
    const { root, cleanup } = buildTree([
      '@guarantees/isolation/unit',
      '@guarantees/isolation/integration',
      '@guarantees/behavior/unit',
      '@architecture/boundaries',
      '@architecture/contracts',
      '@architecture/docs',
      '@integration/drivers',
      '@integration/fault_injection',
      'helpers',
      'fixtures',
    ])
    try {
      // Uses the real assert: any violation would throw and fail this test.
      assertGuaranteeTree(dirUrl(root), assert)
      assert.isTrue(true)
    } finally {
      cleanup()
    }
  })

  test('passes for a minimal tree with the optional tiers absent', ({ assert }) => {
    // Exercises the existsSync-false branch for @architecture and @integration.
    const { root, cleanup } = buildTree(['@guarantees/behavior/unit'])
    try {
      assertGuaranteeTree(dirUrl(root), assert)
      assert.isTrue(true)
    } finally {
      cleanup()
    }
  })

  test('flags every kind of drift', ({ assert }) => {
    const { root, cleanup } = buildTree([
      '@guarantees/isolation/unit',
      '@guarantees/isolation/weird', // bad harness leaf
      '@guarantees/bogus', // unknown guarantee (no leaves)
      '@architecture/boundaries',
      '@architecture/nope', // bad architecture tier
      '@integration/drivers',
      '@integration/bad', // bad integration tier
      'legacy', // stray top-level dir
      'helpers',
    ])
    try {
      const cap = capturingAssert()
      assertGuaranteeTree(dirUrl(root), cap.assert)

      const actuals = cap.calls.map((c) => c.actual as string[])
      // top-level, guarantees, per-guarantee leaves, architecture, integration.
      assert.deepEqual(actuals[0], ['legacy'])
      assert.deepEqual(actuals[1], ['bogus'])
      assert.isTrue(
        actuals.some((a) => a.length === 1 && a[0] === 'weird'),
        'expected the bad harness leaf "weird" to be flagged'
      )
      assert.isTrue(
        actuals.some((a) => a.length === 1 && a[0] === 'nope'),
        'expected the bad architecture tier "nope" to be flagged'
      )
      assert.isTrue(
        actuals.some((a) => a.length === 1 && a[0] === 'bad'),
        'expected the bad integration tier "bad" to be flagged'
      )
      // Sanity: the constants the guard pins against are the imported ones.
      assert.includeMembers([...GUARANTEES], ['isolation'])
    } finally {
      cleanup()
    }
  })
})
