import { test } from '@japa/runner'
import AiAuditWriter, { auditChecksum } from '../../../../src/services/ai_audit_writer.js'
import { fakeAuditEnv, sampleAuditRow } from '../../../helpers/fake_audit_db.js'

/** Build a valid chain of `count` rows for `tenantId` as the DB would return them (snake_case, seq-ascending). */
function chainRows(tenantId: string, count: number): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []
  let prev: string | null = null
  for (let seq = 1; seq <= count; seq++) {
    const row = sampleAuditRow({ tenantId })
    const checksum = auditChecksum(row, seq, prev)
    rows.push({
      id: `id-${tenantId}-${seq}`,
      tenant_id: tenantId,
      seq,
      checksum,
      prev_checksum: prev,
      op: row.op,
      outcome: row.outcome,
      reason: row.reason,
      principal_hash: row.principalHash,
      source_hash: row.sourceHash,
      provider: row.provider,
      model: row.model,
      tokens: row.tokens,
      fragments: row.fragments,
      embeddings_count: row.embeddingsCount,
      dimension: row.dimension,
      match_count: row.matchCount,
      idempotent_replay: row.idempotentReplay,
      occurred_at: row.occurredAt,
    })
    prev = checksum
  }
  return rows
}

function verifierOver(rows: Array<Record<string, unknown>>) {
  return new AiAuditWriter(fakeAuditEnv({ verifyRows: rows }).deps)
}

test.group('behavior — AiAuditWriter verify', () => {
  test('an intact chain verifies clean', async ({ assert }) => {
    const result = await verifierOver(chainRows('t1', 3)).verify()
    assert.isTrue(result.ok)
    assert.equal(result.checked, 3)
    assert.isUndefined(result.break)
  })

  test('a rewritten row (recomputed checksum no longer matches) is reported at its seq', async ({
    assert,
  }) => {
    const rows = chainRows('t1', 3)
    rows[1]!.tokens = 9999 // tamper a data field without re-signing the row
    const result = await verifierOver(rows).verify()
    assert.isFalse(result.ok)
    assert.deepEqual(result.break, { tenantId: 't1', seq: 2, reason: 'checksum' })
  })

  test('a deleted row (seq gap) is reported', async ({ assert }) => {
    const rows = chainRows('t1', 3).filter((r) => r.seq !== 2)
    const result = await verifierOver(rows).verify()
    assert.isFalse(result.ok)
    assert.deepEqual(result.break, { tenantId: 't1', seq: 3, reason: 'gap' })
  })

  test('a broken prev-link is reported', async ({ assert }) => {
    const rows = chainRows('t1', 3)
    rows[2]!.prev_checksum = 'e'.repeat(64)
    const result = await verifierOver(rows).verify()
    assert.isFalse(result.ok)
    assert.deepEqual(result.break, { tenantId: 't1', seq: 3, reason: 'prev_link' })
  })

  test('verify scoped to one tenant ignores another tenant’s tampering', async ({ assert }) => {
    const t2 = chainRows('t2', 2)
    t2[1]!.tokens = 1 // tamper t2's chain
    const rows = [...chainRows('t1', 2), ...t2]
    // Scoped to the intact tenant: clean.
    assert.isTrue((await verifierOver(rows).verify('t1')).ok)
    // Unscoped: the t2 tamper surfaces.
    const all = await verifierOver(rows).verify()
    assert.isFalse(all.ok)
    assert.equal(all.break?.tenantId, 't2')
  })
})
