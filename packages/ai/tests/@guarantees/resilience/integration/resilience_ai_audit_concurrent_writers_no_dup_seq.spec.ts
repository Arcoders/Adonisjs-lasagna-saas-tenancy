import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import {
  setupRealAudit,
  realWriter,
  auditRow,
  centralConn,
  rowsOfResult,
} from '../../../helpers/real_audit_pg.js'

/**
 * The per-tenant audit chain stays contiguous under CONCURRENT
 * writers. The writer serialises the tail-read + seq-compute + INSERT with a
 * `pg_advisory_xact_lock` and a `UNIQUE(tenant_id, seq)` backstop + retry; existing
 * coverage only proves single-writer retry. Here N appends for one tenant race at
 * once and every one must get a distinct, contiguous seq (1..N), the chain must link
 * cleanly, and the on-disk rows must be exactly N with no duplicate seq. Self-skips
 * when Postgres is unavailable, runs in CI.
 */
let ready = false
const N = 12

test.group('AI audit concurrent writers keep a contiguous chain (T3, real pg)', (group) => {
  group.setup(async () => {
    const s = await setupRealAudit()
    ready = s.ready
    return s.cleanup
  })

  test('N concurrent appends for one tenant get distinct contiguous seqs, chain intact', async ({
    assert,
  }) => {
    const tenantId = randomUUID()
    const writer = realWriter(tenantId)

    // Fire N appends at once; the advisory lock must serialise the seq allocation.
    const results = await Promise.all(
      Array.from({ length: N }, () => writer.append(auditRow(tenantId)))
    )

    const seqs = results.map((r) => r.seq).sort((a, b) => a - b)
    assert.deepEqual(
      seqs,
      Array.from({ length: N }, (_, i) => i + 1),
      'every concurrent writer got a distinct, contiguous seq 1..N (no dup, no gap)'
    )
    assert.equal(new Set(seqs).size, N, 'no two rows share a seq')

    // The chain verifies and counts exactly N rows for this tenant.
    const verified = await writer.verify(tenantId)
    assert.isTrue(verified.ok, 'the per-tenant checksum chain is intact after the race')
    assert.equal(verified.checked, N)

    // On disk: exactly N rows, N distinct seqs, for this tenant.
    const client = db.connection(centralConn())
    const res = await client.rawQuery(
      'SELECT count(*) AS c, count(DISTINCT seq) AS d FROM backoffice.ai_audit_logs WHERE tenant_id = ?',
      [tenantId]
    )
    const row = rowsOfResult(res)[0]
    assert.equal(Number(row.c), N)
    assert.equal(
      Number(row.d),
      N,
      'distinct seq count equals row count: no duplicate seq slipped through'
    )
  }).skip(() => !ready, 'postgres not available; runs in CI')
})
