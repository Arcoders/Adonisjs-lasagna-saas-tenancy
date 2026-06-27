#!/usr/bin/env node
// Guards the extension-surface standard: every surface that hosts third-party
// extensions must declare a CONTRACT_VERSION (a positive integer), document it
// in the extensibility standard page, and the demo must declare contractVersion
// on the extensions it registers. Mirrors the structure of
// check-satellite-graduation.mjs (a pure, dependency-free CI gate).
//
// Driven by the SURFACES table below because three surfaces (audit,
// feature-flags, webhooks) live inside packages/core, not in a satellite of
// their own — the "one surface per package" assumption does not hold.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const r = (p) => join(ROOT, p)

/** Each extension surface, the constant that versions it, and where it lives. */
const SURFACES = [
  {
    key: 'reporting',
    constant: 'REPORTING_CONTRACT_VERSION',
    file: 'packages/reporting/src/constants.ts',
  },
  {
    key: 'billing',
    constant: 'BILLING_CONTRACT_VERSION',
    file: 'packages/billing/src/constants.ts',
  },
  {
    key: 'websockets',
    constant: 'WEBSOCKETS_CONTRACT_VERSION',
    file: 'packages/websockets/src/constants.ts',
  },
  { key: 'admin', constant: 'ADMIN_CONTRACT_VERSION', file: 'packages/admin/src/constants.ts' },
  { key: 'sso', constant: 'SSO_CONTRACT_VERSION', file: 'packages/sso/src/constants.ts' },
  {
    key: 'audit',
    constant: 'AUDIT_CONTRACT_VERSION',
    file: 'packages/core/src/services/audit_log_destination_registry.ts',
  },
  {
    key: 'feature-flags',
    constant: 'FEATURE_FLAGS_CONTRACT_VERSION',
    file: 'packages/core/src/services/evaluation_strategy_registry.ts',
  },
  {
    key: 'webhooks',
    constant: 'WEBHOOKS_CONTRACT_VERSION',
    file: 'packages/core/src/services/webhook_transformer_registry.ts',
  },
  {
    key: 'isolation',
    constant: 'ISOLATION_CONTRACT_VERSION',
    file: 'packages/core/src/services/isolation/driver.ts',
  },
  {
    key: 'resolver',
    constant: 'RESOLVER_CONTRACT_VERSION',
    file: 'packages/core/src/services/resolvers/resolver.ts',
  },
]

const DOCS = 'docs/guides/extensibility.md'
const EXAMPLE = 'examples/api/app/providers/app_provider.ts'

const errors = []

for (const s of SURFACES) {
  if (!existsSync(r(s.file))) {
    errors.push(`${s.key}: missing ${s.file}`)
    continue
  }
  const src = readFileSync(r(s.file), 'utf8')
  const match = src.match(new RegExp(`export const ${s.constant}\\s*=\\s*(\\d+)`))
  if (!match) {
    errors.push(`${s.key}: ${s.file} does not \`export const ${s.constant} = <n>\``)
    continue
  }
  if (!(Number.parseInt(match[1], 10) > 0)) {
    errors.push(`${s.key}: ${s.constant} must be a positive integer (got ${match[1]})`)
  }
}

// The standard page must document every surface's contract-version constant, so
// a new surface can't ship without a line in the standard.
if (!existsSync(r(DOCS))) {
  errors.push(`missing the extensibility standard page ${DOCS}`)
} else {
  const docs = readFileSync(r(DOCS), 'utf8')
  for (const s of SURFACES) {
    if (!docs.includes(s.constant)) {
      errors.push(`${DOCS} does not document ${s.constant} (${s.key})`)
    }
  }
}

// The demo must lead by example: any file that registers extensions should
// declare contractVersion on them.
if (existsSync(r(EXAMPLE)) && !readFileSync(r(EXAMPLE), 'utf8').includes('contractVersion')) {
  errors.push(`${EXAMPLE}: the demo extensions must declare \`contractVersion\``)
}

if (errors.length > 0) {
  console.error('check-extension-contracts: FAIL')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log(`check-extension-contracts: OK (${SURFACES.length} surfaces verified)`)
