#!/usr/bin/env node
// Guards that the billing package's `BillingDriverName` is an ALIAS of core's
// `BillingDriverChoice`, not an independently-maintained duplicate union — so the
// two can never drift (a driver name accepted by config but rejected by the
// registry, or vice-versa).
//
// WS-7 / duplicate-billing-driver-name-type. Ships `--self-test`.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const r = (p) => join(ROOT, p)

const BILLING_TYPES = 'packages/billing/src/contracts/types.ts'
const CORE_BILLING = 'packages/core/src/types/config/billing.ts'

/** Pure rule: billing must alias core's choice, and core must still define it. */
function lint(billingSrc, coreSrc) {
  const problems = []
  // Core remains the canonical home of the union.
  if (!/export type BillingDriverChoice\s*=\s*'stripe'/.test(coreSrc)) {
    problems.push('core BillingDriverChoice union is missing or changed shape')
  }
  // Billing must alias it, NOT redeclare the literal union.
  if (!/export type BillingDriverName\s*=\s*BillingDriverChoice\b/.test(billingSrc)) {
    problems.push("billing BillingDriverName must be `= BillingDriverChoice` (alias of core's union)")
  }
  if (/export type BillingDriverName\s*=\s*'stripe'/.test(billingSrc)) {
    problems.push('billing BillingDriverName re-declares the literal union instead of aliasing core')
  }
  return problems
}

if (process.argv.includes('--self-test')) {
  const core = "export type BillingDriverChoice = 'stripe' | 'paddle' | 'lemonsqueezy' | (string & {})"
  const goodBilling = 'export type BillingDriverName = BillingDriverChoice'
  const badBilling = "export type BillingDriverName = 'stripe' | 'paddle' | 'lemonsqueezy' | (string & {})"
  const failures = []
  if (lint(goodBilling, core).length !== 0) failures.push('good fixture flagged')
  if (lint(badBilling, core).length === 0) failures.push('duplicate fixture passed')
  if (failures.length) {
    console.error('check-billing-driver-name-canonical --self-test: FAIL')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('check-billing-driver-name-canonical --self-test: OK')
  process.exit(0)
}

const errors = []
if (!existsSync(r(BILLING_TYPES))) errors.push(`missing ${BILLING_TYPES}`)
if (!existsSync(r(CORE_BILLING))) errors.push(`missing ${CORE_BILLING}`)
if (errors.length === 0) {
  for (const p of lint(readFileSync(r(BILLING_TYPES), 'utf8'), readFileSync(r(CORE_BILLING), 'utf8'))) {
    errors.push(p)
  }
}

if (errors.length > 0) {
  console.error('check-billing-driver-name-canonical: FAIL')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log('check-billing-driver-name-canonical: OK')
