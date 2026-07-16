import { test } from '@japa/runner'
import {
  PgChatAuditSink,
  PgEmbeddingAuditSink,
  PgRetrievalAuditSink,
} from '../../../../src/gateway/audit_sinks.js'
import { hashAuditPrincipal } from '../../../../src/gateway/audit_seam.js'
import type AiAuditWriter from '../../../../src/services/ai_audit_writer.js'
import type { AiAuditEntry, AiAuditRow } from '../../../../src/services/ai_audit_writer.js'

/** A writer spy that captures the mapped row instead of persisting it. */
function spyWriter() {
  const rows: AiAuditRow[] = []
  const writer = {
    async append(row: AiAuditRow): Promise<AiAuditEntry> {
      rows.push(row)
      return { ...row, id: 'id', seq: 1, checksum: 'c', prevChecksum: null }
    },
  } as unknown as AiAuditWriter
  return { writer, rows }
}

/** The exact non-PII column set every persisted row must carry, and nothing more. */
const EXPECTED_KEYS = [
  'tenantId',
  'op',
  'outcome',
  'reason',
  'principalHash',
  'sourceHash',
  'provider',
  'model',
  'tokens',
  'fragments',
  'embeddingsCount',
  'dimension',
  'matchCount',
  'idempotentReplay',
  'occurredAt',
].sort()

const RAW_PRINCIPAL = 'user-secret-42'
const RAW_SOURCE = 's3://tenant/private-doc.pdf'

test.group('security — AI audit persisted row is non-PII', () => {
  test('the chat sink maps a gateway event to a fixed non-PII row', async ({ assert }) => {
    const { writer, rows } = spyWriter()
    const principalHash = hashAuditPrincipal(RAW_PRINCIPAL)!
    await new PgChatAuditSink(writer).append({
      tenantId: 't1',
      principalHash,
      provider: 'claude',
      model: 'claude-opus-4-8',
      outcome: 'completed',
      reason: null,
      tokensSettled: 42,
      fragments: 3,
      idempotentReplay: true,
      occurredAt: '2026-07-03T12:00:00.000Z',
    })
    assert.deepEqual(Object.keys(rows[0]).sort(), EXPECTED_KEYS)
    assert.equal(rows[0].op, 'chat')
    assert.equal(rows[0].tokens, 42)
    assert.equal(rows[0].fragments, 3)
    assert.isTrue(rows[0].idempotentReplay)
    assert.equal(rows[0].principalHash, principalHash)
    assert.match(rows[0].principalHash!, /^[0-9a-f]{64}$/)
    assert.notInclude(JSON.stringify(rows[0]), RAW_PRINCIPAL)
  })

  test('the embedding sink carries the source hash, dimension and count, never raw content', async ({
    assert,
  }) => {
    const { writer, rows } = spyWriter()
    const actorHash = hashAuditPrincipal(RAW_PRINCIPAL)!
    const sourceHash = hashAuditPrincipal(RAW_SOURCE)!
    await new PgEmbeddingAuditSink(writer).append({
      tenantId: 't1',
      actorHash,
      model: 'text-embed',
      dimension: 1536,
      embeddingsCount: 5,
      tokens: 100,
      sourceHash,
      outcome: 'completed',
      reason: null,
      occurredAt: '2026-07-03T12:00:00.000Z',
    })
    assert.deepEqual(Object.keys(rows[0]).sort(), EXPECTED_KEYS)
    assert.equal(rows[0].op, 'embedding')
    assert.equal(rows[0].dimension, 1536)
    assert.equal(rows[0].embeddingsCount, 5)
    assert.equal(rows[0].principalHash, actorHash)
    assert.equal(rows[0].sourceHash, sourceHash)
    assert.notInclude(JSON.stringify(rows[0]), RAW_PRINCIPAL)
    assert.notInclude(JSON.stringify(rows[0]), RAW_SOURCE)
  })

  test('the retrieval sink carries the match count, never the matches', async ({ assert }) => {
    const { writer, rows } = spyWriter()
    const actorHash = hashAuditPrincipal(RAW_PRINCIPAL)!
    await new PgRetrievalAuditSink(writer).append({
      tenantId: 't1',
      actorHash,
      model: 'text-embed',
      matchCount: 8,
      tokens: 12,
      outcome: 'completed',
      reason: null,
      occurredAt: '2026-07-03T12:00:00.000Z',
    })
    assert.deepEqual(Object.keys(rows[0]).sort(), EXPECTED_KEYS)
    assert.equal(rows[0].op, 'retrieval')
    assert.equal(rows[0].matchCount, 8)
    assert.equal(rows[0].principalHash, actorHash)
    assert.notInclude(JSON.stringify(rows[0]), RAW_PRINCIPAL)
  })
})
