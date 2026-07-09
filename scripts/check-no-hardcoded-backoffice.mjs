#!/usr/bin/env node
/**
 * Hardcoded-backoffice guard (Wave 1 — "nada cableado").
 *
 * The backoffice schema and its connection are OPERATOR configuration
 * (`config.backofficeSchemaName` / `config.backofficeConnectionName`). Core honors
 * them everywhere, and its own compliance control documents the hazard: a host that
 * renames the backoffice schema/connection must be honored, "not a hardcoded
 * `'backoffice'`". A raw-SQL writer that hardcodes `backoffice.<table>`, or a wiring
 * site that hardcodes the `'backoffice'` connection name, silently breaks on a
 * renamed-backoffice deployment — and because the WORM ledger / AI audit are
 * fail-closed, that surfaces as 503s, not a warning.
 *
 * This guard fails when a source file:
 *   1. interpolates/writes a `backoffice.<table>` literal into raw SQL, or
 *   2. wires the `'backoffice'` connection name (`connectionName: 'backoffice'` /
 *      `.connection('backoffice')`),
 * outside the config-derived helper (`qualifyBackofficeTable`) and the documented
 * base-model default. Every backoffice table reference must go through
 * `qualifyBackofficeTable(schema, table)` with the configured schema, and every
 * backoffice connection must resolve from `config.backofficeConnectionName`.
 *
 * A deliberate exception carries a `// backoffice-literal-ok: <reason>` marker on the
 * offending line or the line above (e.g. a test harness that creates fixed DDL).
 *
 * Run: `node scripts/check-no-hardcoded-backoffice.mjs` (`--self-test` exercises the
 * detector against known-good/known-bad fixtures).
 */
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// A schema-qualified `backoffice.<table>` reference (raw SQL), or the `'backoffice'`
// connection name wired via `connectionName:` / `.connection(...)`.
// A word-bounded `backoffice.<table>` (SQL tables are lowercase snake_case). The `\b`
// excludes `setup_backoffice.js`-style names, and the negative lookahead excludes
// module file extensions (`./backoffice.js`), so only real SQL table refs match.
const RAW_SQL_RE = /\bbackoffice\.(?!(?:js|ts|mjs|cjs|json|d\.ts)\b)[a-z_]{2,}/
const CONN_RE = /(?:connectionName|connection)\s*:\s*['"]backoffice['"]|\.connection\(\s*['"]backoffice['"]\s*\)/
const EXEMPT_RE = /backoffice-literal-ok/

// Files that legitimately reference the literal, one entry per path with its reason.
// (Beyond these, any /tests/, /stubs/, or examples/ path and the test-kit harness are
// exempt wholesale — they create fixed DDL or are host-owned config.)
const ALLOWED_PATHS = new Map([
  [
    'packages/core/src/utils/backoffice_table.ts',
    'the config-derived helper itself (the one sanctioned place)',
  ],
  [
    'packages/core/src/models/base/backoffice_base_model.ts',
    "the documented class-field default, overwritten from config at boot",
  ],
])

function isComment(line) {
  const t = line.trim()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

/** Returns the violations found in one file's text. */
function scan(text) {
  const lines = text.split('\n')
  const violations = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isComment(line)) continue
    const isRaw = RAW_SQL_RE.test(line)
    const isConn = CONN_RE.test(line)
    if (!isRaw && !isConn) continue
    const marker = lines.slice(Math.max(0, i - 1), i + 1).join('\n')
    if (EXEMPT_RE.test(marker)) continue
    violations.push({ line: i + 1, kind: isRaw ? 'raw-sql backoffice.<table>' : "'backoffice' connection" })
  }
  return violations
}

function isExemptPath(rel) {
  return (
    rel.includes('/tests/') ||
    rel.includes('/stubs/') ||
    rel.startsWith('examples/') ||
    rel.startsWith('packages/satellite-test-kit/')
  )
}

if (process.argv.includes('--self-test')) {
  const badRaw = 'const sql = `SELECT * FROM backoffice.worm_ledger`'
  const badConn = "new Writer({ connectionName: 'backoffice' })"
  const badConn2 = "db.connection('backoffice').table('x')"
  const goodHelper = 'const t = qualifyBackofficeTable(schema, table)'
  const goodConn = 'connectionName: getConfig().backofficeConnectionName,'
  const goodComment = ' * writes to backoffice.worm_ledger via the helper'
  const goodExempt = "// backoffice-literal-ok: fixed test DDL\ndb.connection('backoffice')"
  const checks = [
    ['raw-sql literal flagged', scan(badRaw).length === 1],
    ['connection literal flagged', scan(badConn).length === 1],
    ['.connection() literal flagged', scan(badConn2).length === 1],
    ['helper call passes', scan(goodHelper).length === 0],
    ['config-derived connection passes', scan(goodConn).length === 0],
    ['comment passes', scan(goodComment).length === 0],
    ['exempt-marked passes', scan(goodExempt).length === 0],
  ]
  let ok = true
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`)
    if (!pass) ok = false
  }
  process.exit(ok ? 0 : 1)
}

const tracked = execSync('git ls-files -z -- "packages/**/*.ts"', {
  cwd: ROOT,
  maxBuffer: 64 * 1024 * 1024,
})
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
  .filter((rel) => rel.includes('/src/') || rel.includes('/providers/'))

const failures = []
let scanned = 0
for (const rel of tracked) {
  const norm = rel.replace(/\\/g, '/')
  if (ALLOWED_PATHS.has(norm)) continue
  if (isExemptPath(norm)) continue
  scanned++
  for (const v of scan(readFileSync(join(ROOT, rel), 'utf8'))) {
    failures.push(`${norm}:${v.line}  hardcoded ${v.kind}`)
  }
}

console.log(`check-no-hardcoded-backoffice: scanned ${scanned} files`)
if (failures.length > 0) {
  console.error(
    `\ncheck-no-hardcoded-backoffice: FAIL — ${failures.length} hardcoded backoffice reference(s):\n`
  )
  for (const f of failures) console.error('  - ' + f)
  console.error(
    '\nRoute every backoffice table through qualifyBackofficeTable(schema, table) with the\n' +
      'configured backofficeSchemaName, and resolve the connection from\n' +
      'config.backofficeConnectionName. For a deliberate fixed reference (a test harness),\n' +
      'annotate with `// backoffice-literal-ok: <reason>`.'
  )
  process.exit(1)
}
console.log('check-no-hardcoded-backoffice: passed — no hardcoded backoffice schema/connection literals.')
