#!/usr/bin/env node
/**
 * Quota-key tenant-scoping guard.
 *
 * The reservation cost model is safe against a forged/tampered QuotaReservation
 * handle ONLY because every Redis key in reserve/settle/release is built through
 * the tenant-scoped `*Key(tenantId, day, quota)` builders in
 * `packages/core/src/services/quota/keys.ts` — so a handle whose tenantId was
 * swapped addresses a different namespace and misses the hold (see
 * `security_quota_handle_tamper.spec.ts`). A future refactor that hand-builds a
 * `quota:` key by string interpolation somewhere else could drop the tenantId and
 * silently reintroduce a cross-tenant charge.
 *
 * This guard fails when any source file OTHER than the key-builder module
 * constructs a `quota:`-prefixed Redis key as a string/template literal. The
 * builders are the single sanctioned source of these keys; everything else must
 * call them. A deliberate exception carries a `// quota-key-exempt: <reason>`
 * marker on the line or the line above.
 *
 * Run: `node scripts/check-quota-key-tenant-scoped.mjs` (`--self-test` exercises
 * the detector against known-good/known-bad fixtures).
 */
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The one module allowed to construct `quota:` keys: the builders themselves. */
const BUILDER_FILE = 'packages/core/src/services/quota/keys.ts'

/** A quote or backtick immediately followed by the `quota:` key prefix. */
const KEY_LITERAL_RE = /['"`]quota:/
const EXEMPT_RE = /quota-key-exempt/

/** Returns the violations (hand-built quota keys) found in one file's text. */
function scan(text) {
  const lines = text.split('\n')
  const violations = []
  for (let i = 0; i < lines.length; i++) {
    if (!KEY_LITERAL_RE.test(lines[i])) continue
    const marker = lines.slice(Math.max(0, i - 1), i + 1).join('\n')
    if (EXEMPT_RE.test(marker)) continue
    violations.push({ line: i + 1 })
  }
  return violations
}

if (process.argv.includes('--self-test')) {
  const bad = 'const k = `quota:${tenantId}:${day}:${quota}:holds`'
  const goodBuilder = 'const k = holdsKey(reservation.tenantId, reservation.day, reservation.quota)'
  const goodExempt = '// quota-key-exempt: op scrape reads the shared ceiling key\nconst k = `quota:op:${day}`'
  const checks = [
    ['known-bad hand-built key is flagged', scan(bad).length === 1],
    ['builder call passes', scan(goodBuilder).length === 0],
    ['exempt line passes', scan(goodExempt).length === 0],
  ]
  let ok = true
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`)
    if (!pass) ok = false
  }
  process.exit(ok ? 0 : 1)
}

const tracked = execSync('git ls-files -z -- "packages/**/src/**/*.ts"', {
  cwd: ROOT,
  maxBuffer: 64 * 1024 * 1024,
})
  .toString('utf8')
  .split('\0')
  .filter(Boolean)

const failures = []
let scanned = 0
for (const rel of tracked) {
  if (rel.replace(/\\/g, '/') === BUILDER_FILE) continue // the sanctioned source
  const violations = scan(readFileSync(join(ROOT, rel), 'utf8'))
  scanned++
  for (const v of violations) {
    failures.push(`${rel}:${v.line}  hand-built "quota:" key — call a *Key() builder instead`)
  }
}

console.log(`check-quota-key-tenant-scoped: scanned ${scanned} files`)
if (failures.length > 0) {
  console.error(
    `\ncheck-quota-key-tenant-scoped: FAIL — ${failures.length} hand-built quota key(s):\n`
  )
  for (const f of failures) console.error('  - ' + f)
  console.error(
    '\nEvery quota Redis key must come from a committedKey/holdsKey/amtKey/op*Key builder' +
      `\nin ${BUILDER_FILE} (they embed tenantId, which is what makes a tampered handle harmless).` +
      '\nAdd a `// quota-key-exempt: <reason>` marker only for a deliberate, reviewed exception.' +
      '\nRun locally: node scripts/check-quota-key-tenant-scoped.mjs'
  )
  process.exit(1)
}
console.log('check-quota-key-tenant-scoped: passed — all quota keys come from the tenant-scoped builders.')
