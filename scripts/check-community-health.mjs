#!/usr/bin/env node
// Guards the GitHub community-health files: a Contributor Covenant CODE_OF_CONDUCT
// with a contact address and linked from CONTRIBUTING, plus issue templates
// (bug report + feature request + a config.yml that routes security reports away
// from public issues).
//
// WS-10 / missing-code-of-conduct + missing-issue-templates. Ships `--self-test`.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const r = (p) => join(ROOT, p)

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/

const errors = []

if (process.argv.includes('--self-test')) {
  const failures = []
  // CoC content rule
  const cocOk = (t) => /Contributor Covenant/i.test(t) && EMAIL_RE.test(t)
  if (!cocOk('Contributor Covenant ... report to a@b.com')) failures.push('good CoC flagged')
  if (cocOk('Just be nice.')) failures.push('bad CoC passed')
  if (failures.length) {
    console.error('check-community-health --self-test: FAIL')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('check-community-health --self-test: OK')
  process.exit(0)
}

// CODE_OF_CONDUCT.md: Contributor Covenant + a contact address.
if (!existsSync(r('CODE_OF_CONDUCT.md'))) {
  errors.push('missing CODE_OF_CONDUCT.md')
} else {
  const coc = readFileSync(r('CODE_OF_CONDUCT.md'), 'utf8')
  if (!/Contributor Covenant/i.test(coc)) errors.push('CODE_OF_CONDUCT.md is not the Contributor Covenant')
  if (!EMAIL_RE.test(coc)) errors.push('CODE_OF_CONDUCT.md has no enforcement contact address')
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
