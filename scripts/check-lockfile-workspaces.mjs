#!/usr/bin/env node
/**
 * Fail fast when a workspace package is missing from package-lock.json.
 *
 * Adding a new workspace (e.g. a satellite under `packages/`) without
 * regenerating the lockfile leaves `npm ci` broken in every CI job, with a
 * confusing "Missing: <pkg> from lock file" error deep in the install step.
 * This guard catches that drift in milliseconds — no network, no install — by
 * checking that every workspace directory with a package.json is registered in
 * the lockfile's `packages` map (lockfileVersion 3, keyed by relative path).
 *
 * Fix when it fails: `npm install --package-lock-only --legacy-peer-deps`, then
 * commit package-lock.json.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
const lockPackages = lock.packages || {}

// Resolve the `workspaces` globs to concrete directories. Lockfile keys always
// use forward slashes, so build keys from the pattern strings (which do too),
// never from path.join (backslashes on Windows).
const dirs = []
for (const pattern of pkg.workspaces || []) {
  if (pattern.endsWith('/*')) {
    const base = pattern.slice(0, -2)
    const baseDir = join(root, base)
    if (!existsSync(baseDir)) continue
    for (const name of readdirSync(baseDir)) {
      const full = join(baseDir, name)
      if (statSync(full).isDirectory() && existsSync(join(full, 'package.json'))) {
        dirs.push(`${base}/${name}`)
      }
    }
  } else if (existsSync(join(root, pattern, 'package.json'))) {
    dirs.push(pattern)
  }
}

const missing = dirs.filter((d) => !(d in lockPackages))
if (missing.length > 0) {
  console.error('check-lockfile-workspaces: package-lock.json is out of sync.')
  console.error('Missing workspace package(s) from the lockfile:')
  for (const m of missing) console.error(`  - ${m}`)
  console.error('\nFix: npm install --package-lock-only --legacy-peer-deps')
  console.error('Then commit package-lock.json. (CI `npm ci` fails on an out-of-sync lockfile.)')
  process.exit(1)
}

console.log(`check-lockfile-workspaces: passed (${dirs.length} workspaces present in package-lock.json)`)
