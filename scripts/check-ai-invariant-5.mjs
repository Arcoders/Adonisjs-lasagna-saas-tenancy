#!/usr/bin/env node
// check-ai-invariant-5: the I5 structural guard for the AI satellite's audit.
//
// I5 (packages/ai/ARCHITECTURE.md): "Every prompt, response, embedding op, and
// cost event is append-only audited with attribution." The dedicated AI audit
// table must replicate the kernel's full DB-trigger set (BEFORE UPDATE/DELETE/
// TRUNCATE, RAISE EXCEPTION regardless of role) and store ONLY non-PII metadata
// (counts, ids, model, one-way hashes) so GDPR erasure never has to chase content
// into the immutable log (#14, G1).
//
// This scans two surfaces:
//   1. the backoffice migration stub (create_ai_audit_logs_table.stub) for the
//      four triggers incl. the statement-level TRUNCATE, and for a column set that
//      is EXACTLY the reviewed non-PII allowlist (a new column is a reviewed edit);
//   2. the audit sinks (audit_sinks.ts, when present) for any PII-stem object key,
//      so a raw prompt/response/query can never be mapped into a persisted row.
//
// Pure auditor exported for a focused unit test; the runner reads the real files.

import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const STUB_PATH = 'packages/ai/stubs/migrations/create_ai_audit_logs_table.stub'
const SINKS_PATH = 'packages/ai/src/gateway/audit_sinks.ts'

/**
 * The fixed non-PII column allowlist for `backoffice.ai_audit_logs` (the union of
 * the three frozen audit event field sets plus the seq+checksum chain columns).
 * Adding a column here is the reviewed decision the guard forces.
 */
export const ALLOWED_COLUMNS = [
  'id',
  'tenant_id',
  'seq',
  'checksum',
  'prev_checksum',
  'op',
  'outcome',
  'reason',
  'principal_hash',
  'source_hash',
  'provider',
  'model',
  'tokens',
  'fragments',
  'embeddings_count',
  'dimension',
  'match_count',
  'idempotent_replay',
  'occurred_at',
  'created_at',
]

// PII stems that must never appear as a persisted column or as a mapped object
// key. `principal` and `source` are allowed ONLY in `*_hash` form (a one-way
// digest), which the column allowlist already encodes.
const PII_KEY = /\b(prompt|response|content|message|query|text|input|body|email|ip_address)\s*:/i

const REQUIRED_TRIGGERS = [
  {
    label: 'the no_mutate function',
    re: /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+backoffice\.ai_audit_logs_no_mutate/i,
  },
  { label: 'a BEFORE UPDATE trigger', re: /BEFORE\s+UPDATE\s+ON\s+backoffice\.ai_audit_logs/i },
  { label: 'a BEFORE DELETE trigger', re: /BEFORE\s+DELETE\s+ON\s+backoffice\.ai_audit_logs/i },
  {
    label: 'a statement-level BEFORE TRUNCATE trigger',
    re: /BEFORE\s+TRUNCATE\s+ON\s+backoffice\.ai_audit_logs[\s\S]*?FOR\s+EACH\s+STATEMENT/i,
  },
]

/** Column names declared by the Lucid `table.<type>('<name>'...)` calls. */
function stubColumns(source) {
  const names = []
  const re = /\btable\.\w+\(\s*'([a-z_]+)'/g
  let m
  while ((m = re.exec(source)) !== null) names.push(m[1])
  return names
}

/**
 * Audit the AI audit surfaces. `files` is a list of `{ path, source }`. Returns a
 * list of problem strings (empty = ok). Pure, so a unit test can drive it without
 * a filesystem.
 */
export function auditAppendOnlyAudit(files) {
  const problems = []
  const stub = files.find((f) => f.path.endsWith('create_ai_audit_logs_table.stub'))
  const sinks = files.find((f) => /audit_sinks\.[jt]s$/.test(f.path))

  if (stub) {
    for (const trig of REQUIRED_TRIGGERS) {
      if (!trig.re.test(stub.source)) {
        problems.push(`${stub.path}: append-only audit table is missing ${trig.label} (I5, #6)`)
      }
    }

    const cols = stubColumns(stub.source)
    const allowed = new Set(ALLOWED_COLUMNS)
    for (const col of cols) {
      if (!allowed.has(col)) {
        problems.push(
          `${stub.path}: column '${col}' is not in the reviewed non-PII allowlist (I5, #14); add it to ALLOWED_COLUMNS with review, or drop it`
        )
      }
    }
    for (const want of ALLOWED_COLUMNS) {
      if (!cols.includes(want)) {
        problems.push(
          `${stub.path}: allowlisted column '${want}' is missing from the audit table (I5); the persisted shape must match the reviewed allowlist`
        )
      }
    }
  }

  if (sinks) {
    sinks.source.split('\n').forEach((line, i) => {
      const t = line.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
      if (PII_KEY.test(line)) {
        problems.push(
          `${sinks.path}:${i + 1}: an audit sink maps a PII-stem key into a persisted row (I5, #14, G1); persist only non-PII metadata (counts, ids, model, *_hash)`
        )
      }
    })
  }

  return problems
}

function run() {
  const files = []
  const stubAbs = join(repoRoot, STUB_PATH)
  if (existsSync(stubAbs)) files.push({ path: STUB_PATH, source: readFileSync(stubAbs, 'utf8') })
  const sinksAbs = join(repoRoot, SINKS_PATH)
  if (existsSync(sinksAbs)) files.push({ path: SINKS_PATH, source: readFileSync(sinksAbs, 'utf8') })

  const problems = auditAppendOnlyAudit(files)

  if (problems.length > 0) {
    console.error(
      `check-ai-invariant-5: ${problems.length} I5 (append-only audit) violation(s):\n  ` +
        problems.join('\n  ')
    )
    process.exit(1)
  }
  console.log(
    `check-ai-invariant-5: OK (${files.length} AI audit file(s), triggers replicated + columns non-PII).`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
