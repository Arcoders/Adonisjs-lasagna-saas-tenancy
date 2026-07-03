import { test } from '@japa/runner'
// The I5 guard is a repo-root script (it runs in `npm run check`); import its pure
// auditor to exercise the append-only audit rules: the dedicated AI audit table
// must replicate the full DB-trigger set (incl. the statement-level TRUNCATE) and
// carry EXACTLY the reviewed non-PII column allowlist, and the sinks must never map
// a PII-stem key into a persisted row.
import {
  auditAppendOnlyAudit,
  ALLOWED_COLUMNS,
} from '../../../../../scripts/check-ai-invariant-5.mjs'

const STUB = 'packages/ai/stubs/migrations/create_ai_audit_logs_table.stub'
const SINKS = 'src/gateway/audit_sinks.ts'

const TRIGGERS = `
  CREATE OR REPLACE FUNCTION backoffice.ai_audit_logs_no_mutate() RETURNS TRIGGER AS $$
  BEGIN RAISE EXCEPTION 'append-only'; END; $$ LANGUAGE plpgsql;
  CREATE TRIGGER ai_audit_logs_no_update BEFORE UPDATE ON backoffice.ai_audit_logs FOR EACH ROW EXECUTE FUNCTION backoffice.ai_audit_logs_no_mutate();
  CREATE TRIGGER ai_audit_logs_no_delete BEFORE DELETE ON backoffice.ai_audit_logs FOR EACH ROW EXECUTE FUNCTION backoffice.ai_audit_logs_no_mutate();
  CREATE TRIGGER ai_audit_logs_no_truncate BEFORE TRUNCATE ON backoffice.ai_audit_logs FOR EACH STATEMENT EXECUTE FUNCTION backoffice.ai_audit_logs_no_mutate();
`

function stubSource(columns, triggers = TRIGGERS) {
  const colLines = columns.map((c) => `      table.string('${c}').nullable()`).join('\n')
  return [
    `this.schema.withSchema('backoffice').createTable('ai_audit_logs', (table) => {`,
    colLines,
    `      table.unique(['tenant_id', 'seq'], 'ai_audit_logs_tenant_seq_uq')`,
    `    })`,
    triggers,
  ].join('\n')
}

test.group('architectural — I5 append-only audit guard', () => {
  test('a stub with all four triggers and the exact allowlist passes', ({ assert }) => {
    const problems = auditAppendOnlyAudit([{ path: STUB, source: stubSource(ALLOWED_COLUMNS) }])
    assert.deepEqual(problems, [])
  })

  test('a missing statement-level TRUNCATE trigger is a violation', ({ assert }) => {
    const noTruncate = TRIGGERS.replace(/CREATE TRIGGER ai_audit_logs_no_truncate[\s\S]*?;\n/, '')
    const problems = auditAppendOnlyAudit([
      { path: STUB, source: stubSource(ALLOWED_COLUMNS, noTruncate) },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /TRUNCATE/)
  })

  test('an unknown column is a violation', ({ assert }) => {
    const problems = auditAppendOnlyAudit([
      { path: STUB, source: stubSource([...ALLOWED_COLUMNS, 'extra_col']) },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /reviewed non-PII allowlist/)
  })

  test('a missing allowlisted column is a violation', ({ assert }) => {
    const problems = auditAppendOnlyAudit([
      { path: STUB, source: stubSource(ALLOWED_COLUMNS.filter((c) => c !== 'checksum')) },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /missing from the audit table/)
  })

  test('the one-way hash columns are allowed', ({ assert }) => {
    assert.isTrue(ALLOWED_COLUMNS.includes('principal_hash'))
    assert.isTrue(ALLOWED_COLUMNS.includes('source_hash'))
    const problems = auditAppendOnlyAudit([{ path: STUB, source: stubSource(ALLOWED_COLUMNS) }])
    assert.deepEqual(problems, [])
  })

  test('a sink mapping only non-PII keys passes', ({ assert }) => {
    const source = `const row = { tenant_id: e.tenantId, op: 'chat', outcome: e.outcome, model: e.model, principal_hash: hashAuditPrincipal(e.principal), tokens: e.tokensSettled }`
    const problems = auditAppendOnlyAudit([{ path: SINKS, source }])
    assert.deepEqual(problems, [])
  })

  test('a sink mapping a PII-stem key into a row is a violation', ({ assert }) => {
    const source = `const row = { tenant_id: e.tenantId, content: e.messageText }`
    const problems = auditAppendOnlyAudit([{ path: SINKS, source }])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /PII-stem key/)
  })

  test('a comment naming a PII stem in the sinks is not flagged', ({ assert }) => {
    const source = `// never persist prompt: or response: content, only *_hash and counts\nconst row = { tokens: e.tokens }`
    const problems = auditAppendOnlyAudit([{ path: SINKS, source }])
    assert.deepEqual(problems, [])
  })
})
