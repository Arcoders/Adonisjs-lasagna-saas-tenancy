#!/usr/bin/env node
// Guards the GitHub community-health files: a substantive CODE_OF_CONDUCT with a
// contact address and linked from CONTRIBUTING, plus issue templates (bug report
// + feature request + a config.yml that routes security reports away from public
// issues).
//
// The CoC rule is NOT pinned to the Contributor Covenant text: a project may ship
// its own Code of Conduct as long as it is a real document (a contact address
// plus the core sections any CoC carries — pledge, standards, enforcement), not a
// one-line stub.
//
// WS-10 / missing-code-of-conduct + missing-issue-templates. Ships `--self-test`.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const r = (p) => join(ROOT, p)

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/
// Section markers a substantive Code of Conduct carries (Contributor Covenant and
// most custom CoCs alike). We require a contact address plus a majority of these.
const COC_MARKERS = [/\bpledge\b/i, /\bstandards\b/i, /\benforcement\b/i, /harass|unacceptable/i]

/**
 * Pure rule: return the problems with a CoC document string. A real CoC needs a
 * contact address AND at least 3 of the section markers AND a non-trivial length;
 * a one-liner ("Just be nice.") fails on all three.
 */
function cocProblems(t) {
  const problems = []
  if (!EMAIL_RE.test(t)) problems.push('CODE_OF_CONDUCT.md has no enforcement contact address')
  const hits = COC_MARKERS.filter((re) => re.test(t)).length
  if (t.length < 500 || hits < 3) {
    problems.push(
      'CODE_OF_CONDUCT.md is not a substantive Code of Conduct ' +
        '(needs pledge / standards / enforcement sections)'
    )
  }
  return problems
}

const errors = []

if (process.argv.includes('--self-test')) {
  const failures = []
  const goodCoc =
    '# Code of Conduct\n## Our Pledge\n' +
    'x'.repeat(500) +
    '\n## Our Standards\nunacceptable behaviour\n## Enforcement\nreport to a@b.com'
  if (cocProblems(goodCoc).length !== 0) failures.push('good CoC flagged')
  if (cocProblems('Just be nice. a@b.com').length === 0) failures.push('stub CoC passed')
  if (cocProblems(goodCoc.replace('a@b.com', 'no email')).length === 0) {
    failures.push('CoC with no contact address passed')
  }
  if (failures.length) {
    console.error('check-community-health --self-test: FAIL')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('check-community-health --self-test: OK')
  process.exit(0)
}

// CODE_OF_CONDUCT.md: a substantive Code of Conduct + a contact address.
if (!existsSync(r('CODE_OF_CONDUCT.md'))) {
  errors.push('missing CODE_OF_CONDUCT.md')
} else {
  for (const p of cocProblems(readFileSync(r('CODE_OF_CONDUCT.md'), 'utf8'))) errors.push(p)
}

// Linked from CONTRIBUTING.
if (existsSync(r('CONTRIBUTING.md'))) {
  if (!/CODE_OF_CONDUCT/.test(readFileSync(r('CONTRIBUTING.md'), 'utf8'))) {
    errors.push('CONTRIBUTING.md does not link to CODE_OF_CONDUCT.md')
  }
}

// Issue templates.
const TEMPLATES = [
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
]
for (const t of TEMPLATES) {
  if (!existsSync(r(t))) errors.push(`missing ${t}`)
}
if (existsSync(r('.github/ISSUE_TEMPLATE/config.yml'))) {
  const cfg = readFileSync(r('.github/ISSUE_TEMPLATE/config.yml'), 'utf8')
  if (!/security/i.test(cfg)) errors.push('.github/ISSUE_TEMPLATE/config.yml has no security contact link')
}

if (errors.length > 0) {
  console.error('check-community-health: FAIL')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log('check-community-health: OK')
