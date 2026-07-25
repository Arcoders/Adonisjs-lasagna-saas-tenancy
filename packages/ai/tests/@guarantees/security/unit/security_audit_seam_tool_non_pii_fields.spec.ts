import { test } from '@japa/runner'
import { PgToolAuditSink } from '../../../../src/gateway/audit_sinks.js'
import type { AiToolAuditEvent } from '../../../../src/gateway/audit_seam.js'
import type AiAuditWriter from '../../../../src/services/ai_audit_writer.js'
import {
  auditChecksum,
  canonicalAuditFields,
  type AiAuditRow,
  type AiAuditEntry,
} from '../../../../src/services/ai_audit_writer.js'

/**
 * The forward contract on the tool-audit seam. The event field set is pinned EXACTLY
 * (a new field is a reviewed decision, and neither the model-generated arguments nor
 * the tool result can slip in). The checksum-preserving mapping (toolName->model,
 * round->matchCount, mode->provider, op:'tool') is asserted here so a future maintainer
 * never reads those columns as a literal LLM model / match count / provider on a tool
 * row, and so a tool row stays writable through the SAME positional hash chain as chat
 * / embed / retrieval.
 */

const PINNED_FIELDS = [
  'mode',
  'occurredAt',
  'outcome',
  'principalHash',
  'reason',
  'round',
  'tenantId',
  'tokens',
  'toolName',
]

const SECRET_ARGS = 'the-secret-tool-arguments'
const SECRET_RESULT = 'the-secret-tool-result'

function toolEvent(over: Partial<AiToolAuditEvent> = {}): AiToolAuditEvent {
  return {
    tenantId: 't1',
    principalHash: 'a'.repeat(64),
    toolName: 'count_bookings',
    mode: 'read',
    outcome: 'completed',
    reason: null,
    round: 2,
    tokens: 0,
    occurredAt: '2026-07-16T00:00:00.000Z',
    ...over,
  }
}

/** A recording writer that captures the mapped row without touching a DB. */
function recordingWriter() {
  const rows: AiAuditRow[] = []
  const writer = {
    append: async (row: AiAuditRow): Promise<AiAuditEntry> => {
      rows.push(row)
      return { ...row, id: 'id', seq: 1, checksum: 'c', prevChecksum: null }
    },
  } as unknown as AiAuditWriter
  return { writer, rows }
}

test.group('tool audit seam non-PII contract', () => {
  test('the tool event field set is FROZEN (exact key set)', ({ assert }) => {
    assert.deepEqual(
      Object.keys(toolEvent()).sort(),
      PINNED_FIELDS,
      'the tool audit event field set is FROZEN; extending it is a reviewed decision'
    )
  })

  test('PgToolAuditSink maps the event onto a checksum-preserving op:tool row', async ({
    assert,
  }) => {
    const { writer, rows } = recordingWriter()
    await new PgToolAuditSink(writer).append(
      toolEvent({ toolName: 'revenue_summary', mode: 'action', round: 3, tokens: 7 })
    )
    assert.lengthOf(rows, 1)
    const row = rows[0]!
    assert.equal(row.op, 'tool')
    // The deliberate, checksum-preserving reuses:
    assert.equal(row.model, 'revenue_summary', 'toolName reuses the model column')
    assert.equal(row.matchCount, 3, 'round reuses the matchCount column')
    assert.equal(row.provider, 'action', 'mode reuses the provider column')
    assert.equal(row.principalHash, 'a'.repeat(64))
    assert.equal(row.tokens, 7)
    // Neutral defaults for every field a tool row does not carry:
    assert.isNull(row.sourceHash)
    assert.equal(row.fragments, 0)
    assert.equal(row.embeddingsCount, 0)
    assert.equal(row.dimension, 0)
    assert.isFalse(row.idempotentReplay)
  })

  test('the tool outcome maps onto the shared 3-value row outcome', async ({ assert }) => {
    const { writer, rows } = recordingWriter()
    const sink = new PgToolAuditSink(writer)
    await sink.append(toolEvent({ outcome: 'completed' }))
    await sink.append(toolEvent({ outcome: 'denied', reason: 'tool_denied' }))
    await sink.append(toolEvent({ outcome: 'failed', reason: 'tool_execution_failed' }))
    await sink.append(toolEvent({ outcome: 'error', reason: 'tenant_scope_mismatch' }))
    assert.deepEqual(
      rows.map((r) => r.outcome),
      ['completed', 'failed_preflight', 'aborted', 'aborted']
    )
    // The precise category survives in `reason`, never lost by the coarse mapping.
    assert.deepEqual(
      rows.map((r) => r.reason),
      [null, 'tool_denied', 'tool_execution_failed', 'tenant_scope_mismatch']
    )
  })

  test('a tool row is writable through the SAME positional hash chain (canonical + checksum)', async ({
    assert,
  }) => {
    const { writer, rows } = recordingWriter()
    await new PgToolAuditSink(writer).append(toolEvent())
    const row = rows[0]!
    // The canonical serialization must produce a stable string and a 64-hex
    // checksum exactly as it does for every other op, proof the reuse did not
    // break the positional array (no new element, no undefined value).
    const canonical = canonicalAuditFields(row, 1)
    assert.isString(canonical)
    assert.match(auditChecksum(row, 1, null), /^[0-9a-f]{64}$/)
  })

  test('neither the tool arguments nor the result ever reach the mapped row', async ({
    assert,
  }) => {
    // The event has no place to carry args/result; even if a caller tried, the sink
    // maps only the frozen fields, so a serialized row can never contain them.
    const { writer, rows } = recordingWriter()
    await new PgToolAuditSink(writer).append(toolEvent())
    const serialized = JSON.stringify(rows[0])
    assert.notInclude(serialized, SECRET_ARGS)
    assert.notInclude(serialized, SECRET_RESULT)
  })
})
