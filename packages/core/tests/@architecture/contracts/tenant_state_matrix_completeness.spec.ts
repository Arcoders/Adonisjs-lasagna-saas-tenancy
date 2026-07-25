import { test } from '@japa/runner'
import { TENANT_STATUSES } from '../../../src/types/contracts.js'
import { TENANT_STATE_MATRIX } from '../../../src/services/doctor/tenant_state_matrix.js'
import { tenantLifecycleDisposition } from '../../../src/middleware/tenant_lifecycle_disposition.js'
import { builtInChecks } from '../../../src/services/doctor/checks/index.js'
import { SAFE_FIX_BY_CODE, SURFACE_ONLY } from '../../../src/services/doctor/safe_fix_registry.js'

/**
 * A4 — the curated composite state matrix must stay coherent with the live system: every
 * status appears as a reachable state, every row's request-path disposition equals the
 * live classifier, every non-healthy row is owned by a registered check, and every
 * expected diagnosis code is a known doctor code. (It pins those invariants over the
 * hand-maintained rows; it does not exhaustively generate every status × storage × ledger
 * composite — see the matrix docstring.) Retires the phantom "row N" comments.
 */
test.group('tenant state matrix completeness', () => {
  test('every TENANT_STATUSES value appears as some matrix row status', ({ assert }) => {
    const covered = new Set(TENANT_STATE_MATRIX.map((r) => r.status))
    const missing = TENANT_STATUSES.filter((s) => !covered.has(s))
    assert.deepEqual(missing, [], `statuses with no matrix row: ${missing.join(', ')}`)
  })

  test('each row disposition equals the live tenantLifecycleDisposition for that row', ({
    assert,
  }) => {
    for (const row of TENANT_STATE_MATRIX) {
      const live = tenantLifecycleDisposition({ status: row.status, isDeleted: row.deletedAt })
      assert.equal(
        row.disposition,
        live,
        `${row.id}: matrix says ${row.disposition}, floor says ${live}`
      )
    }
  })

  test('every non-healthy row is owned by a registered doctor check', ({ assert }) => {
    const names = new Set(builtInChecks.map((c) => c.name))
    for (const row of TENANT_STATE_MATRIX) {
      if (row.expected === 'healthy') continue
      assert.isTrue(
        names.has(row.expected.owningCheck),
        `${row.id}: owningCheck "${row.expected.owningCheck}" is not a registered check`
      )
    }
  })

  test('every non-healthy expected code is a known doctor code (fixable or surface-only)', ({
    assert,
  }) => {
    const known = new Set([...SAFE_FIX_BY_CODE.keys(), ...SURFACE_ONLY.keys()])
    for (const row of TENANT_STATE_MATRIX) {
      if (row.expected === 'healthy') continue
      assert.isTrue(
        known.has(row.expected.code),
        `${row.id}: expected code "${row.expected.code}" is neither fixable nor surface-only`
      )
    }
  })

  test('row ids are unique', ({ assert }) => {
    const ids = TENANT_STATE_MATRIX.map((r) => r.id)
    assert.equal(new Set(ids).size, ids.length, 'duplicate matrix row id')
  })
})
