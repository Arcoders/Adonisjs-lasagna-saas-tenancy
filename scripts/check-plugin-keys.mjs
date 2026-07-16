#!/usr/bin/env node
/**
 * Plugin-platform key guard (E2 — "nothing wired").
 *
 * Every scheduler identifier that must stay coherent between its producer (the
 * scheduler service arming a native schedule) and any consumer (the tick job the
 * schedule dispatches) is built through `packages/core/src/sdk/plugin_keys.ts`:
 * the deterministic native schedule id (`lasagna.scheduler.<name>`) and the tick
 * job name (`lasagna.TenantSchedulerTick`). Idempotent upsert depends on both
 * sides computing the SAME id; a stray hand-built literal elsewhere would silently
 * create a duplicate schedule or point at a job the worker never registered.
 *
 * This guard fails when any source file OTHER than the key-builder module
 * constructs one of those namespaced literals as a string/template. A deliberate
 * exception carries a `// plugin-key-exempt: <reason>` marker on the line or the
 * line above.
 *
 * Run: `node scripts/check-plugin-keys.mjs` (`--self-test` exercises the detector
 * against known-good/known-bad fixtures).
 */
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The one module allowed to construct plugin-platform keys: the builders. */
const BUILDER_FILE = 'packages/core/src/sdk/plugin_keys.ts'

/** A quote/backtick immediately followed by a scheduler-namespaced literal. */
const KEY_LITERAL_RE = /['"`]lasagna\.(scheduler|TenantSchedulerTick)/
const EXEMPT_RE = /plugin-key-exempt/

/** Returns the violations (hand-built plugin keys) found in one file's text. */
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
  const badId = 'const id = `lasagna.scheduler.${name}`'
  const badJob = "await queue.add('lasagna.TenantSchedulerTick', payload)"
  const goodBuilder = 'const id = schedulerScheduleId(schedule.name)'
  const goodConst = 'static options = { name: SCHEDULER_TICK_JOB_NAME }'
  const goodExempt = '// plugin-key-exempt: doc example only\nconst id = `lasagna.scheduler.demo`'
  const checks = [
    ['known-bad hand-built schedule id is flagged', scan(badId).length === 1],
    ['known-bad hand-built tick job name is flagged', scan(badJob).length === 1],
    ['builder call passes', scan(goodBuilder).length === 0],
    ['imported constant passes', scan(goodConst).length === 0],
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
    failures.push(`${rel}:${v.line}  hand-built plugin key — call a plugin_keys.ts builder instead`)
  }
}

console.log(`check-plugin-keys: scanned ${scanned} files`)
if (failures.length > 0) {
  console.error(`\ncheck-plugin-keys: FAIL — ${failures.length} hand-built plugin key(s):\n`)
  for (const f of failures) console.error('  - ' + f)
  console.error(
    `\nEvery scheduler identifier must come from ${BUILDER_FILE}` +
      '\n(schedulerScheduleId / schedulerJobId / SCHEDULER_TICK_JOB_NAME) so the producer and' +
      '\nconsumer of a schedule can never disagree on its id.' +
      '\nAdd a `// plugin-key-exempt: <reason>` marker only for a deliberate, reviewed exception.' +
      '\nRun locally: node scripts/check-plugin-keys.mjs'
  )
  process.exit(1)
}
console.log('check-plugin-keys: passed — all plugin keys come from the single-source builders.')
