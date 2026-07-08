import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { walkTsFiles } from '../../helpers/walk_ts_files.js'

/**
 * WS-6 / backoffice-tables-no-isolation-backstop (critic P1).
 *
 * The backoffice schema is shared across all tenants and has NO per-row
 * isolation backstop: a `BackofficeBaseModel.query()` that forgets a
 * `tenant_id` filter silently reads or writes across tenants. This guard is the
 * source-level backstop: every query on a backoffice model must EITHER scope by
 * `tenant_id`/`tenantId` in the same statement, OR be explicitly tagged
 * `// backoffice-scope-exempt: <reason>` so a genuine cross-tenant sweep is a
 * deliberate, reviewable decision and never an oversight.
 *
 * RED (pre-fix): the `processRetries` cross-tenant delivery sweep was unscoped
 * and unmarked, so this guard flagged it (and nothing forced future queries to
 * declare their intent).
 */

const SRC = fileURLToPath(new URL('../../../src', import.meta.url))

// Models that live in the shared backoffice schema, DISCOVERED from source (every
// `class X extends BackofficeBaseModel` under core src) rather than a hand-list: a
// new core backoffice model is guarded automatically instead of silently escaping
// the sweep. The standalone `check-backoffice-isolation.mjs` guard applies the same
// discovery across every package (satellites included).
const EXTENDS_BACKOFFICE = /\bclass\s+([A-Za-z0-9_]+)\s+extends\s+BackofficeBaseModel\b/g
function discoverBackofficeModels(): string[] {
  const names = new Set<string>()
  for (const file of walkTsFiles(SRC)) {
    const text = readFileSync(file, 'utf8')
    let m: RegExpExecArray | null
    const re = new RegExp(EXTENDS_BACKOFFICE.source, 'g')
    while ((m = re.exec(text)) !== null) names.add(m[1])
  }
  return [...names].sort()
}
const BACKOFFICE_MODELS = discoverBackofficeModels()

const QUERY_RE = new RegExp(`\\b(${BACKOFFICE_MODELS.join('|')})\\.query\\(`)
const SCOPE_RE = /tenant_?id/i // tenant_id (column) or tenantId (camel)
const EXEMPT_RE = /backoffice-scope-exempt/

interface Violation {
  file: string
  line: number
  model: string
}

/**
 * A query site is OK when the statement (its line + a short window of
 * continuation lines) references a tenant scope, OR it carries the exempt
 * marker on the query line or the line just above it.
 */
function scanFile(path: string): Violation[] {
  const lines = readFileSync(path, 'utf8').split('\n')
  const violations: Violation[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = QUERY_RE.exec(lines[i])
    if (!m) continue
    const windowEnd = Math.min(lines.length, i + 6)
    const stmt = lines.slice(i, windowEnd).join('\n')
    const marker = lines.slice(Math.max(0, i - 1), windowEnd).join('\n')
    if (SCOPE_RE.test(stmt) || EXEMPT_RE.test(marker)) continue
    violations.push({ file: path, line: i + 1, model: m[1] })
  }
  return violations
}

test.group('architectural — backoffice models are tenant-scoped or marked exempt', () => {
  test('every backoffice-model query is scoped by tenant or explicitly exempt', ({ assert }) => {
    const violations: Violation[] = []
    for (const file of walkTsFiles(SRC)) {
      if (file.includes(`${'models'}`) && file.includes('satellites')) continue // model defs themselves
      violations.push(...scanFile(file))
    }
    assert.deepEqual(
      violations,
      [],
      `Unscoped backoffice query(ies) found — add a tenant_id filter or a ` +
        `\`// backoffice-scope-exempt: <reason>\` marker:\n` +
        violations.map((v) => `  ${v.model}.query() at ${v.file}:${v.line}`).join('\n')
    )
  })

  test('detector controls: catches a known-bad fixture and ignores a known-good one', ({
    assert,
  }) => {
    // Known-bad: an unscoped, unmarked query must be flagged.
    const bad = ['const x = TenantWebhook.query()', "  .where('id', id)", '  .first()'].join('\n')
    // Known-good (scoped) and known-good (exempt).
    const goodScoped = ['TenantWebhook.query()', "  .where('tenant_id', tenantId)"].join('\n')
    const goodExempt = [
      '// backoffice-scope-exempt: cross-tenant sweep',
      'TenantWebhook.query()',
    ].join('\n')

    const scan = (text: string) => {
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (!QUERY_RE.test(lines[i])) continue
        const windowEnd = Math.min(lines.length, i + 6)
        const stmt = lines.slice(i, windowEnd).join('\n')
        const marker = lines.slice(Math.max(0, i - 1), windowEnd).join('\n')
        if (!(SCOPE_RE.test(stmt) || EXEMPT_RE.test(marker))) return true // a violation exists
      }
      return false
    }

    assert.isTrue(scan(bad), 'an unscoped, unmarked query must be detected')
    assert.isFalse(scan(goodScoped), 'a tenant-scoped query must pass')
    assert.isFalse(scan(goodExempt), 'an exempt-marked query must pass')
  })
})
