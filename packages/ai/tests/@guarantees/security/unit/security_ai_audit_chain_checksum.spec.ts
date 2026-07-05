import { test } from '@japa/runner'
import {
  auditChecksum,
  canonicalAuditFields,
  type AiAuditRow,
} from '../../../../src/services/ai_audit_writer.js'
import { sampleAuditRow } from '../../../helpers/fake_audit_db.js'

test.group('security — AI audit chain checksum', () => {
  test('is a deterministic 64-hex digest', ({ assert }) => {
    const row = sampleAuditRow()
    assert.equal(auditChecksum(row, 1, null), auditChecksum(row, 1, null))
    assert.match(auditChecksum(row, 1, null), /^[0-9a-f]{64}$/)
  })

  test('the canonical form is array-shaped (no object-key-order ambiguity)', ({ assert }) => {
    assert.isTrue(canonicalAuditFields(sampleAuditRow(), 1).startsWith('['))
  })

  test('mutating any attributed field changes the checksum', ({ assert }) => {
    const base = auditChecksum(sampleAuditRow(), 1, null)
    const overrides: Partial<AiAuditRow>[] = [
      { op: 'embedding' },
      { outcome: 'aborted' },
      { reason: 'x' },
      { tokens: 43 },
      { model: 'other' },
      { provider: 'deepseek' },
      { matchCount: 1 },
      { fragments: 4 },
      { embeddingsCount: 2 },
      { dimension: 1536 },
      { idempotentReplay: true },
      { principalHash: 'b'.repeat(64) },
      { sourceHash: 'c'.repeat(64) },
      { occurredAt: '2026-07-03T12:00:01.000Z' },
    ]
    for (const over of overrides) {
      assert.notEqual(
        auditChecksum(sampleAuditRow(over), 1, null),
        base,
        `mutating ${JSON.stringify(over)} must change the checksum`
      )
    }
  })

  test('seq and prev-link are part of the digest (chain linkage)', ({ assert }) => {
    const row = sampleAuditRow()
    assert.notEqual(auditChecksum(row, 1, null), auditChecksum(row, 2, null))
    assert.notEqual(auditChecksum(row, 2, 'a'.repeat(64)), auditChecksum(row, 2, 'b'.repeat(64)))
  })

  test('occurred_at is normalized so equivalent instants hash equally (verify round-trip)', ({
    assert,
  }) => {
    assert.equal(
      auditChecksum(sampleAuditRow({ occurredAt: '2026-07-03T12:00:00.000Z' }), 1, null),
      auditChecksum(sampleAuditRow({ occurredAt: '2026-07-03T12:00:00Z' }), 1, null)
    )
  })
})
