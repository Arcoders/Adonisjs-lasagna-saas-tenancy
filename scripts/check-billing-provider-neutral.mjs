#!/usr/bin/env node
// Guards that the provider-neutral billing surfaces carry no Stripe-specific
// branding: no `/webhooks/stripe` default path, and no stale `ProcessStripeEventJob`
// reference (the job is `ProcessBillingEventJob`). The Stripe DRIVER files
// (drivers/stripe/**, stripe_ip_allowlist.ts) are exempt — they are legitimately
// Stripe-specific.
//
// WS-7 / billing-config-stripe-specific-defaults-in-neutral-block. Ships
// `--self-test`.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const r = (p) => join(ROOT, p)

/** Neutral surfaces and the patterns banned in each. */
const SURFACES = [
  {
    file: 'packages/billing/src/webhook_path.ts',
    banned: [{ re: /['"]\/webhooks\/stripe['"]/, why: "Stripe-branded default webhook path (use '/webhooks/billing')" }],
  },
  {
    file: 'packages/billing/src/routes.ts',
    banned: [{ re: /['"]\/webhooks\/stripe['"]/, why: "Stripe-branded webhook path literal (use '/webhooks/billing')" }],
  },
  {
    file: 'packages/core/src/types/config/billing.ts',
    banned: [{ re: /ProcessStripeEventJob/, why: 'stale ProcessStripeEventJob reference (renamed to ProcessBillingEventJob)' }],
  },
  {
    file: 'packages/billing/src/exceptions/billing_exception.ts',
    banned: [{ re: /ProcessStripeEventJob/, why: 'stale ProcessStripeEventJob reference' }],
  },
  {
    file: 'packages/billing/providers/billing_provider.ts',
    banned: [{ re: /ProcessStripeEventJob/, why: 'stale ProcessStripeEventJob reference' }],
  },
  {
    file: 'packages/core/src/jobs/index.ts',
    banned: [{ re: /ProcessStripeEventJob/, why: 'stale ProcessStripeEventJob reference' }],
  },
]

/** Pure rule: return the violated `why`s for one source string. */
function lint(src, banned) {
  return banned.filter((b) => b.re.test(src)).map((b) => b.why)
}

if (process.argv.includes('--self-test')) {
  const bannedRules = SURFACES[0].banned
  const failures = []
  if (lint("const p = '/webhooks/billing'", bannedRules).length !== 0) failures.push('good fixture flagged')
  if (lint("const p = '/webhooks/stripe'", bannedRules).length === 0) failures.push('bad fixture passed')
  const jobRules = SURFACES[1].banned
  if (lint('dispatch ProcessBillingEventJob', jobRules).length !== 0) failures.push('good job fixture flagged')
  if (lint('dispatch ProcessStripeEventJob', jobRules).length === 0) failures.push('bad job fixture passed')
  if (failures.length) {
    console.error('check-billing-provider-neutral --self-test: FAIL')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('check-billing-provider-neutral --self-test: OK')
  process.exit(0)
}

const errors = []
for (const s of SURFACES) {
  if (!existsSync(r(s.file))) {
    errors.push(`missing ${s.file}`)
    continue
  }
  for (const why of lint(readFileSync(r(s.file), 'utf8'), s.banned)) {
    errors.push(`${s.file}: ${why}`)
  }
}

if (errors.length > 0) {
  console.error('check-billing-provider-neutral: FAIL')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log(`check-billing-provider-neutral: OK (${SURFACES.length} surfaces verified)`)
