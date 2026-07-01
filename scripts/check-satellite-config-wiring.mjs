#!/usr/bin/env node
// Guards that every config-bearing satellite exposes the SAME config-authoring
// surface as the reporting satellite: a `define<X>Config` identity helper and a
// `MultitenancyConfigWith<X>` merged type, both exported from its public barrel.
// Before WS-7 there were four different patterns (reporting had both, websockets
// had a provider-local type, billing/backup had neither).
//
// WS-7 / satellite-config-wiring-four-patterns. Ships `--self-test`.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const r = (p) => join(ROOT, p)

const SATELLITES = [
  { key: 'reporting', index: 'packages/reporting/src/index.ts', define: 'defineReportingConfig', type: 'MultitenancyConfigWithReporting' },
  { key: 'billing', index: 'packages/billing/src/index.ts', define: 'defineBillingConfig', type: 'MultitenancyConfigWithBilling' },
  { key: 'backup', index: 'packages/backup/src/index.ts', define: 'defineBackupConfig', type: 'MultitenancyConfigWithBackup' },
  { key: 'websockets', index: 'packages/websockets/src/index.ts', define: 'defineWebSocketsConfig', type: 'MultitenancyConfigWithWebsockets' },
  { key: 'ai', index: 'packages/ai/src/index.ts', define: 'defineAiConfig', type: 'MultitenancyConfigWithAi' },
]

/** Pure rule: which of {define, type} are missing from the barrel source. */
function lint(src, define, type) {
  const problems = []
  if (!new RegExp(`\\b${define}\\b`).test(src)) problems.push(`barrel does not export ${define}`)
  if (!new RegExp(`\\b${type}\\b`).test(src)) problems.push(`barrel does not export ${type}`)
  return problems
}

if (process.argv.includes('--self-test')) {
  const good = 'export { defineXConfig } from "./x.js"\nexport type { MultitenancyConfigWithX } from "./x.js"'
  const failures = []
  if (lint(good, 'defineXConfig', 'MultitenancyConfigWithX').length !== 0) failures.push('good fixture flagged')
  if (lint('export {}', 'defineXConfig', 'MultitenancyConfigWithX').length !== 2) failures.push('bad fixture not fully flagged')
  if (failures.length) {
    console.error('check-satellite-config-wiring --self-test: FAIL')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('check-satellite-config-wiring --self-test: OK')
  process.exit(0)
}

const errors = []
for (const s of SATELLITES) {
  if (!existsSync(r(s.index))) {
    errors.push(`${s.key}: missing ${s.index}`)
    continue
  }
  for (const p of lint(readFileSync(r(s.index), 'utf8'), s.define, s.type)) {
    errors.push(`${s.key}: ${p}`)
  }
}

if (errors.length > 0) {
  console.error('check-satellite-config-wiring: FAIL')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log(`check-satellite-config-wiring: OK (${SATELLITES.length} satellites verified)`)
