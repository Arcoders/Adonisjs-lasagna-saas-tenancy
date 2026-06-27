#!/usr/bin/env node
// Guards that CONTRIBUTING documents the blocking CI gates honestly: a `check`
// aggregate script exists, CONTRIBUTING points at it and the core gates, and it
// does NOT call lint optional (prettier/prettier is an ESLint error → lint is a
// hard gate).
//
// WS-10 / contributing-omits-blocking-ci-gates. Ships `--self-test`.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const r = (p) => join(ROOT, p)

// `check:full` covers the build-dependent gates `npm run check` can't run alone
// (the doc code-fence gate + a full typecheck); `bench:isolation` is the
// infra-dependent isolation/error-rate gate. Both are CI-blocking but easy to
// forget locally, so CONTRIBUTING must name them.
const REQUIRED_MENTIONS = [
  'npm run lint',
  'npm run typecheck',
  'npm test',
  'npm run check',
  'npm run check:full',
  'npm run bench:isolation',
]
const BANNED = /lint`?\s+if you want to check/i

/** Pure rule over (package.json scripts, CONTRIBUTING text). */
function lint(scripts, contributing) {
  const problems = []
  if (!scripts || typeof scripts.check !== 'string') {
    problems.push('root package.json has no "check" aggregate script')
  }
  for (const m of REQUIRED_MENTIONS) {
    if (!contributing.includes(m)) problems.push(`CONTRIBUTING.md does not mention \`${m}\``)
  }
  if (BANNED.test(contributing)) {
    problems.push('CONTRIBUTING.md still presents lint as optional ("lint if you want to check")')
  }
  return problems
}

if (process.argv.includes('--self-test')) {
  const goodScripts = { check: 'node scripts/check.mjs' }
  const goodDoc =
    'Run npm run lint, npm run typecheck, npm test, npm run check, npm run check:full, ' +
    'and (for isolation changes) npm run bench:isolation before pushing.'
  const badDoc = 'Run `npm run lint` if you want to check, or let your editor handle it.'
  const failures = []
  if (lint(goodScripts, goodDoc).length !== 0) failures.push('good fixture flagged')
  if (lint({}, goodDoc).length === 0) failures.push('missing-check-script not flagged')
  if (lint(goodScripts, badDoc).length === 0) failures.push('optional-lint phrasing not flagged')
  if (failures.length) {
    console.error('check-contributing-gates --self-test: FAIL')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('check-contributing-gates --self-test: OK')
  process.exit(0)
}

const errors = []
const pkg = existsSync(r('package.json')) ? JSON.parse(readFileSync(r('package.json'), 'utf8')) : {}
const contributing = existsSync(r('CONTRIBUTING.md')) ? readFileSync(r('CONTRIBUTING.md'), 'utf8') : ''
if (!contributing) errors.push('missing CONTRIBUTING.md')
else errors.push(...lint(pkg.scripts, contributing))

if (errors.length > 0) {
  console.error('check-contributing-gates: FAIL')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log('check-contributing-gates: OK')
