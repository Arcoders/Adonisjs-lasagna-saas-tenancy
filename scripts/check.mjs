#!/usr/bin/env node
// Aggregate gate: runs every fast source-scan guard CI enforces, so a
// contributor can validate locally with one command (`npm run check`). Excludes
// gates that need a build (check-docs-code) or a coverage file
// (check-satellite-coverage) — CI runs those in their own jobs. Keep this list in
// sync as guards are added; it is the single place CI and contributors share.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

const GUARDS = [
  'check-lockfile-workspaces.mjs',
  'check-doc-paths.mjs',
  'check-positioning.mjs',
  'check-stability-versions.mjs',
  'check-readme-links.mjs',
  'check-readme-counts.mjs',
  'check-satellite-graduation.mjs',
  'check-extension-contracts.mjs',
  'check-backoffice-isolation.mjs',
  'check-quota-key-tenant-scoped.mjs',
  'check-routes-options-naming.mjs',
  'check-billing-provider-neutral.mjs',
  'check-billing-driver-name-canonical.mjs',
  'check-abi-boot-assertion.mjs',
  'check-plugin-permissions.mjs',
  'check-plugin-keys.mjs',
  'check-satellite-config-wiring.mjs',
  'check-peer-ranges.mjs',
  'check-publish-coverage.mjs',
  'check-contributing-gates.mjs',
  'check-community-health.mjs',
  'check-japa-thunk-contract.mjs',
  'check-bench-paths.mjs',
  'check-isthmus.mjs',
  'check-no-silent-catch.mjs',
  'check-satellite-migrations.mjs',
  'check-ai-invariant-1.mjs',
  'check-ai-invariant-2.mjs',
  'check-ai-invariant-4.mjs',
  'check-ai-invariant-5.mjs',
  'check-ai-invariant-8.mjs',
  'check-ai-no-prompt-logging-for-training.mjs',
  'check-ai-no-provider-prompt-cache.mjs',
  'check-crypto-invariant-1.mjs',
  'check-crypto-invariant-2.mjs',
  'check-crypto-invariant-3.mjs',
  'check-crypto-invariant-4.mjs',
  'check-crypto-invariant-5.mjs',
  'check-crypto-invariant-6.mjs',
  'check-crypto-invariant-7.mjs',
  'check-crypto-invariant-8.mjs',
  'check-crypto-invariant-9.mjs',
  'check-crypto-invariant-10.mjs',
  'check-crypto-invariant-11.mjs',
]

const failed = []
for (const guard of GUARDS) {
  try {
    execFileSync(process.execPath, [join(HERE, guard)], { stdio: 'inherit' })
  } catch {
    failed.push(guard)
  }
}

if (failed.length > 0) {
  console.error(`\ncheck: FAIL — ${failed.length} guard(s) failed: ${failed.join(', ')}`)
  process.exit(1)
}
console.log(`\ncheck: OK — all ${GUARDS.length} guards passed`)
