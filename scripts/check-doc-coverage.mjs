#!/usr/bin/env node
/**
 * Documentation Coverage gate (Deliverable B2). Thin wrapper around the
 * `docs:doctor` CLI in `packages/doc-coverage`, run against source via tsx so no
 * build step is required. See docs/dev/doc-coverage-rfc.md.
 *
 * Exit codes are forwarded verbatim from the tool:
 *   0  clean (no blocking gate finding)
 *   1  a blocking gate finding (new drift not in the baseline)
 *   2  the tool itself errored
 *
 * Out of the box the gate is conservative: dead-member is `warn`, coverage floors
 * default to 0, so this never blocks on day 1. Promote checks to `gate` and raise
 * floors (with a baseline) to ratchet drift down over time.
 *
 * Pass-through flags, e.g.:  node scripts/check-doc-coverage.mjs --since origin/master...HEAD
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'packages', 'doc-coverage', 'bin', 'docs_doctor.ts')

// Run via `node --import tsx <entry.ts>`: no npx, no shell (so user-passed flags
// are never concatenated into a shell command), cross-platform, no DEP0190.
const result = spawnSync(process.execPath, ['--import', 'tsx', entry, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
})

if (result.error) {
  console.error('check-doc-coverage: failed to launch docs:doctor:', result.error.message)
  process.exit(2)
}
process.exit(result.status ?? 2)
