import { test } from '@japa/runner'
import {
  lifecycleLevel,
  healthGe,
  healthGt,
  healthEq,
  dataPreserves,
  dataEqual,
  type HealthVector,
  type DataFingerprint,
} from '../../../../src/services/doctor/health_lattice.js'

/**
 * C3 — the health-lattice "theorem" encoded as data. These pin the ordering the
 * do-no-harm property harness relies on: that each fix moves a tenant UP the lattice,
 * and that "accurate + actionable" outranks "stuck + lying".
 */
const H = (v: Partial<HealthVector>): HealthVector => ({
  lifecycle: 0,
  storage: 0,
  ledgerFidelity: 0,
  runtimeCircuit: 0,
  recoverability: 0,
  ...v,
})

test.group('health lattice — lifecycle ordering', () => {
  test('a consistent active tenant is the top of the lifecycle axis', ({ assert }) => {
    assert.isAbove(lifecycleLevel('active', false), lifecycleLevel('suspended', false))
    assert.isAbove(lifecycleLevel('active', false), lifecycleLevel('failed', false))
  })

  test('failed (heal-recoverable) outranks stalled provisioning (inert)', ({ assert }) => {
    // The plan's key claim: provisioning_stalled → failed is a RISE.
    assert.isAbove(lifecycleLevel('failed', false), lifecycleLevel('provisioning', false))
  })

  test('an active row carrying a deletedAt (serving a lie) is the bottom', ({ assert }) => {
    assert.equal(lifecycleLevel('active', true), 0)
    // Reconciling it to a consistent deleted state is a rise.
    assert.isAbove(lifecycleLevel('deleted', true), lifecycleLevel('active', true))
  })

  test('a deleted row with no deletedAt (divergence) is also the bottom', ({ assert }) => {
    assert.equal(lifecycleLevel('deleted', false), 0)
    assert.isAbove(lifecycleLevel('deleted', true), lifecycleLevel('deleted', false))
  })
})

test.group('health lattice — product order', () => {
  test('healthGe is the per-axis product order', ({ assert }) => {
    assert.isTrue(healthGe(H({ storage: 1, ledgerFidelity: 1 }), H({ storage: 1 })))
    assert.isFalse(healthGe(H({ storage: 1 }), H({ storage: 1, ledgerFidelity: 1 })))
  })

  test('healthGt requires ≥ on all axes and > on at least one', ({ assert }) => {
    assert.isTrue(healthGt(H({ ledgerFidelity: 1 }), H({})))
    assert.isFalse(healthGt(H({}), H({})))
    // Incomparable vectors are never strictly greater.
    assert.isFalse(healthGt(H({ storage: 1 }), H({ ledgerFidelity: 1 })))
  })

  test('healthEq is mutual ≥', ({ assert }) => {
    assert.isTrue(healthEq(H({ storage: 1 }), H({ storage: 1 })))
    assert.isFalse(healthEq(H({ storage: 1 }), H({ storage: 2 })))
  })

  test('reconcile raises ledger fidelity while keeping every other axis equal', ({ assert }) => {
    const before = H({ lifecycle: 4, storage: 1, ledgerFidelity: 0 })
    const after = H({ lifecycle: 4, storage: 1, ledgerFidelity: 1 })
    assert.isTrue(healthGt(after, before))
    assert.equal(after.lifecycle, before.lifecycle)
    assert.equal(after.storage, before.storage)
  })
})

test.group('health lattice — data order', () => {
  const fp = (entries: Array<[string, number, string[]]>): DataFingerprint =>
    new Map(entries.map(([t, count, columns]) => [t, { count, columns }]))

  test('dataPreserves allows added rows/columns but not removed', ({ assert }) => {
    const before = fp([['t', 3, ['id', 'name']]])
    assert.isTrue(dataPreserves(fp([['t', 5, ['id', 'name', 'extra']]]), before))
    assert.isFalse(dataPreserves(fp([['t', 2, ['id', 'name']]]), before), 'fewer rows is harm')
    assert.isFalse(dataPreserves(fp([['t', 3, ['id']]]), before), 'a dropped column is harm')
    assert.isFalse(dataPreserves(fp([]), before), 'a dropped table is harm')
  })

  test('dataEqual demands a byte-identical fingerprint (physical-identity fixes)', ({ assert }) => {
    const a = fp([['t', 3, ['id', 'name']]])
    assert.isTrue(dataEqual(a, fp([['t', 3, ['id', 'name']]])))
    assert.isFalse(dataEqual(a, fp([['t', 4, ['id', 'name']]])))
    assert.isFalse(dataEqual(a, fp([['t', 3, ['id', 'name', 'extra']]])))
  })
})
