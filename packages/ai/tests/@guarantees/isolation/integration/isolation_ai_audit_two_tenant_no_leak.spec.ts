import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import {
  setupRealAudit,
  realWriter,
  auditRow,
  centralConn,
  rowsOfResult,
} from '../../../helpers/real_audit_pg.js'

/**
 * Two-tenant isolation on REAL Postgres: the audit table is shared (backoffice),
 * so isolation is by `tenant_id` + a per-tenant `(tenant_id, seq)` chain. Two
 * tenants write into the same table, each chain starts at seq 1 and links only its
 * own rows, and a verify scoped to tenant A never reads or links tenant B's rows.
 * Self-skips when Postgres is unavailable, runs in CI.
 */
let ready = false

test.group('AI audit two-tenant isolation (real pg)', (group) => {
  group.setup(async () => {
    const s = await setupRealAudit()
    ready = s.ready
    return s.cleanup
  })

  test('each tenant keeps an independent chain; a scoped verify never links across tenants', async ({
    assert,
  }) => {
    const a = realWriter('t-iso-a')
    const b = realWriter('t-iso-b')
    const a1 = await a.append(auditRow('t-iso-a'))
    const a2 = await a.append(auditRow('t-iso-a'))
    const b1 = await b.append(auditRow('t-iso-b'))

    // Each tenant's chain starts at seq 1 and links only its own rows.
    assert.equal(a1.seq, 1)
    assert.equal(a2.seq, 2)
    assert.equal(a2.prevChecksum, a1.checksum)
    assert.equal(b1.seq, 1)
    assert.isNull(b1.prevChecksum)

    // Scoped verify: each tenant's chain is intact and counts only its own rows.
    const va = await a.verify('t-iso-a')
    assert.isTrue(va.ok)
    assert.equal(va.checked, 2)
    const vb = await b.verify('t-iso-b')
    assert.isTrue(vb.ok)
    assert.equal(vb.checked, 1)

    // On disk, every tenant's minimum seq is 1 (independent numbering).
    const client = db.connection(centralConn())
    const res = await client.rawQuery(
      'SELECT tenant_id, min(seq) AS m FROM backoffice.ai_audit_logs GROUP BY tenant_id'
    )
    for (const row of rowsOfResult(res)) assert.equal(Number(row.m), 1)
  }).skip(() => !ready, 'postgres not available; runs in CI')
})
