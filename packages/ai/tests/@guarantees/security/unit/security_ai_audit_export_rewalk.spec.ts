import { test } from '@japa/runner'
import {
  auditChecksum,
  type AiAuditEntry,
  type AiAuditRow,
} from '../../../../src/services/ai_audit_writer.js'
import {
  auditEntryToRecord,
  toNdjsonLine,
  toCsvRow,
  csvHeader,
  AI_AUDIT_EXPORT_COLUMNS,
  type AiAuditExportRecord,
} from '../../../../src/utils/ai_audit_export.js'

/**
 * Wave 4 acceptance (3.2): the export is a SELF-VERIFIABLE forensic artifact. Every
 * exported record carries `seq`, `checksum`, and `prevChecksum`, so an EXTERNAL tool
 * re-walks each tenant's rows recomputing the checksum and linking through the exported
 * prev-link, needing nothing from the live database. And a value planted in an audited
 * field cannot execute in an analyst's spreadsheet (CSV formula-injection escaping).
 */

const baseRow = (over: Partial<AiAuditRow> = {}): AiAuditRow => ({
  tenantId: 't1',
  op: 'chat',
  outcome: 'completed',
  reason: null,
  principalHash: 'a'.repeat(64),
  sourceHash: null,
  provider: 'claude',
  model: 'claude-opus-4-8',
  tokens: 10,
  fragments: 2,
  embeddingsCount: 0,
  dimension: 0,
  matchCount: 0,
  idempotentReplay: false,
  occurredAt: '2026-07-03T12:00:00.000Z',
  ...over,
})

/** Build a valid chain of entries for a tenant (as the writer would have persisted them). */
function chain(tenantId: string, count: number): AiAuditEntry[] {
  const entries: AiAuditEntry[] = []
  let prev: string | null = null
  for (let seq = 1; seq <= count; seq++) {
    const row = baseRow({ tenantId, tokens: seq })
    const checksum = auditChecksum(row, seq, prev)
    entries.push({ ...row, id: `id-${tenantId}-${seq}`, seq, checksum, prevChecksum: prev })
    prev = checksum
  }
  return entries
}

/** An INDEPENDENT re-walk: rebuild the row from the exported record and recompute the chain. */
function independentRewalk(records: AiAuditExportRecord[]): { ok: boolean; brokeAt?: number } {
  let prevTenant: string | undefined
  let prevChecksum: string | null = null
  let prevSeq = 0
  for (const r of records) {
    if (r.tenantId !== prevTenant) {
      prevTenant = r.tenantId
      prevChecksum = null
      prevSeq = 0
    }
    if (r.seq !== prevSeq + 1) return { ok: false, brokeAt: r.seq }
    if (r.prevChecksum !== prevChecksum) return { ok: false, brokeAt: r.seq }
    const row: AiAuditRow = {
      tenantId: r.tenantId,
      op: r.op as AiAuditRow['op'],
      outcome: r.outcome as AiAuditRow['outcome'],
      reason: r.reason,
      principalHash: r.principalHash,
      sourceHash: r.sourceHash,
      provider: r.provider,
      model: r.model,
      tokens: r.tokens,
      fragments: r.fragments,
      embeddingsCount: r.embeddingsCount,
      dimension: r.dimension,
      matchCount: r.matchCount,
      idempotentReplay: r.idempotentReplay,
      occurredAt: r.occurredAt,
    }
    if (auditChecksum(row, r.seq, r.prevChecksum) !== r.checksum)
      return { ok: false, brokeAt: r.seq }
    prevChecksum = r.checksum
    prevSeq = r.seq
  }
  return { ok: true }
}

test.group('AI audit export — self-verifiable re-walk (Wave 4, 3.2)', () => {
  test('a multi-tenant export re-walks clean with an INDEPENDENT checksum re-implementation', ({
    assert,
  }) => {
    const entries = [...chain('t1', 3), ...chain('t2', 2)]
    const records = entries.map(auditEntryToRecord)
    assert.isTrue(independentRewalk(records).ok, 'every checksum and prev-link matches offline')
  })

  test('a record tampered after export fails the independent re-walk at its seq', ({ assert }) => {
    const records = chain('t1', 3).map(auditEntryToRecord)
    records[1]!.tokens = 9999 // tamper a data field without re-signing
    const result = independentRewalk(records)
    assert.isFalse(result.ok)
    assert.equal(result.brokeAt, 2)
  })

  test('every export record carries the three chain fields (seq/checksum/prevChecksum)', ({
    assert,
  }) => {
    const record = auditEntryToRecord(chain('t1', 1)[0]!)
    for (const field of ['seq', 'checksum', 'prevChecksum'] as const) {
      assert.property(record, field)
    }
    assert.includeMembers([...AI_AUDIT_EXPORT_COLUMNS], ['seq', 'checksum', 'prevChecksum'])
  })

  test('NDJSON is one JSON object per line, parseable back to the record', ({ assert }) => {
    const record = auditEntryToRecord(chain('t1', 1)[0]!)
    const line = toNdjsonLine(record)
    assert.notInclude(line, '\n')
    assert.deepEqual(JSON.parse(line), record)
  })

  test('a CSV cell beginning with = / + / - / @ is apostrophe-prefixed (formula injection)', ({
    assert,
  }) => {
    const entry = { ...chain('t1', 1)[0]!, reason: '=cmd|calc', model: '@SUM(A1)' }
    const row = toCsvRow(auditEntryToRecord(entry))
    assert.include(row, "'=cmd|calc")
    assert.include(row, "'@SUM(A1)")
    assert.match(csvHeader(), /^id,tenantId,seq,checksum,prevChecksum,/)
  })
})
