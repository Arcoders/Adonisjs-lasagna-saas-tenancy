#!/usr/bin/env node
// Guards that every public "routes options" type a satellite exports uses the
// `Multitenancy*RoutesOptions` prefix, so the surfaces read consistently
// (MultitenancyAdminRoutesOptions, MultitenancyReportingRoutesOptions). A bare
// `ReportingRoutesOptions` is only allowed as a `@deprecated` type alias, never
// as the canonical `export interface`.
//
// WS-7 / routes-options-typename-inconsistency. Ships with `--self-test`.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const r = (p) => join(ROOT, p)

const SURFACES = [
  {
    key: 'admin',
    file: 'packages/admin/src/routes.ts',
    canonical: 'MultitenancyAdminRoutesOptions',
  },
  {
    key: 'reporting',
    file: 'packages/reporting/src/routes.ts',
    canonical: 'MultitenancyReportingRoutesOptions',
  },
]

/** The two rules, as a pure function so the self-test can exercise them. */
function lint(src, canonical) {
  const problems = []
  const hasCanonical =
    new RegExp(`export interface ${canonical}\\b`).test(src) ||
    new RegExp(`export type ${canonical}\\b`).test(src)
  if (!hasCanonical) problems.push(`missing the canonical \`${canonical}\``)

  // Any unprefixed *RoutesOptions declared as an `interface` is a violation;
  // the old name must be a `type` alias (which the next rule tolerates).
  for (const m of src.matchAll(/export interface (\w+RoutesOptions)\b/g)) {
    if (!m[1].startsWith('Multitenancy')) {
      problems.push(`\`${m[1]}\` must be Multitenancy-prefixed (keep the old name only as a deprecated type alias)`)
    }
  }
  return problems
}

if (process.argv.includes('--self-test')) {
  const good = `export interface MultitenancyReportingRoutesOptions { prefix?: string }
/** @deprecated */ export type ReportingRoutesOptions = MultitenancyReportingRoutesOptions`
  const bad = `export interface ReportingRoutesOptions { prefix?: string }`
  const failures = []
  if (lint(good, 'MultitenancyReportingRoutesOptions').length !== 0) failures.push('good fixture flagged')
  if (lint(bad, 'MultitenancyReportingRoutesOptions').length === 0) failures.push('bad fixture passed')
  if (failures.length) {
    console.error('check-routes-options-naming --self-test: FAIL')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('check-routes-options-naming --self-test: OK')
  process.exit(0)
}

const errors = []
for (const s of SURFACES) {
  if (!existsSync(r(s.file))) {
    errors.push(`${s.key}: missing ${s.file}`)
    continue
  }
  for (const p of lint(readFileSync(r(s.file), 'utf8'), s.canonical)) {
    errors.push(`${s.key}: ${p}`)
  }
}

if (errors.length > 0) {
  console.error('check-routes-options-naming: FAIL')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log(`check-routes-options-naming: OK (${SURFACES.length} surfaces verified)`)
