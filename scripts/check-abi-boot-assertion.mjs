#!/usr/bin/env node
// Guards that every satellite that ships a PROVIDER calls
// assertSatelliteApiCompatAtBoot in its boot(), and that the satelliteApi literal
// passed there matches the package's own package.json#lasagnaSatellite.satelliteApi
// (single source of truth — the literal can't drift). configure gates ABI once at
// install; this is the runtime backstop for a later core downgrade.
//
// WS-7 / abi-contract-check-configure-time-only. Ships `--self-test`.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const r = (p) => join(ROOT, p)

/** Satellites that ship a provider (sso/admin ship none, so nothing to assert). */
const PROVIDERS = [
  { key: 'billing', provider: 'packages/billing/providers/billing_provider.ts', pkg: 'packages/billing/package.json' },
  { key: 'backup', provider: 'packages/backup/providers/backup_provider.ts', pkg: 'packages/backup/package.json' },
  { key: 'reporting', provider: 'packages/reporting/providers/reporting_provider.ts', pkg: 'packages/reporting/package.json' },
  { key: 'websockets', provider: 'packages/websockets/providers/websockets_provider.ts', pkg: 'packages/websockets/package.json' },
]

const CALL_RE = /assertSatelliteApiCompatAtBoot\(\s*\{\s*satelliteApi:\s*(\d+)\s*\}/

/** Pure rule: given provider source + the package's declared satelliteApi, return problems. */
function lint(providerSrc, declaredApi) {
  const problems = []
  const m = providerSrc.match(CALL_RE)
  if (!m) {
    problems.push('boot() does not call assertSatelliteApiCompatAtBoot({ satelliteApi: <n> }, ...)')
    return problems
  }
  const literal = Number.parseInt(m[1], 10)
  if (literal !== declaredApi) {
    problems.push(`satelliteApi literal ${literal} != package.json#lasagnaSatellite.satelliteApi ${declaredApi}`)
  }
  return problems
}

if (process.argv.includes('--self-test')) {
  const failures = []
  const good = 'async boot(){ assertSatelliteApiCompatAtBoot({ satelliteApi: 1 }, "@x/y") }'
  if (lint(good, 1).length !== 0) failures.push('good fixture flagged')
  if (lint('async boot(){ /* nothing */ }', 1).length === 0) failures.push('missing-call fixture passed')
  if (lint(good, 2).length === 0) failures.push('mismatched-version fixture passed')
  if (failures.length) {
    console.error('check-abi-boot-assertion --self-test: FAIL')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('check-abi-boot-assertion --self-test: OK')
  process.exit(0)
}

const errors = []
for (const s of PROVIDERS) {
  if (!existsSync(r(s.provider))) {
    errors.push(`${s.key}: missing provider ${s.provider}`)
    continue
  }
  if (!existsSync(r(s.pkg))) {
    errors.push(`${s.key}: missing ${s.pkg}`)
    continue
  }
  const pkg = JSON.parse(readFileSync(r(s.pkg), 'utf8'))
  const declaredApi = pkg?.lasagnaSatellite?.satelliteApi
  if (typeof declaredApi !== 'number') {
    errors.push(`${s.key}: ${s.pkg} has no numeric lasagnaSatellite.satelliteApi`)
    continue
  }
  for (const p of lint(readFileSync(r(s.provider), 'utf8'), declaredApi)) {
    errors.push(`${s.key}: ${p}`)
  }
}

if (errors.length > 0) {
  console.error('check-abi-boot-assertion: FAIL')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log(`check-abi-boot-assertion: OK (${PROVIDERS.length} providers verified)`)
