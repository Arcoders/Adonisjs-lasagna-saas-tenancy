// Fast guard against broken runtime file paths in the benchmarks workspace.
//
// The bench tiers spawn the fixture server via `new URL(...)` paths resolved at
// runtime, which `tsc` does not check and which the benches (not run locally,
// they clobber baselines) only exercise in CI. A tier that moved between
// directory depths once left `new URL('../fixture/bin/server.ts', import.meta.url)`
// pointing at a non-existent path, so the server never started.
//
// This scans every benchmarks/src/*.ts for `new URL('<rel>', <base>)` where base
// is `import.meta.url` (resolved against the file) or `FIXTURE_ROOT` (resolved
// against benchmarks/fixture/), and asserts each resolves to an existing file or
// directory. Linear I/O over a handful of files via `git ls-files` (no tree walk,
// no node_modules), so it runs in milliseconds with no services.

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = pathToFileURL(join(repoRoot, 'benchmarks', 'fixture') + '/')

const files = execFileSync('git', ['ls-files', 'benchmarks/src/**/*.ts'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)

const pattern = /new\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*(import\.meta\.url|FIXTURE_ROOT)\s*\)/g

const problems = []
let checked = 0
for (const rel of files) {
  const abs = join(repoRoot, rel)
  const source = readFileSync(abs, 'utf8')
  for (const match of source.matchAll(pattern)) {
    const [, target, base] = match
    // Only check file references (the bug class: a spawned/imported file path that
    // drifts when a tier changes depth). Directory references (trailing slash) are
    // skipped: some are runtime output dirs that are gitignored and absent on a
    // clean clone (e.g. results/), and a committed dir's drift is caught anyway by
    // the file refs resolved against it.
    if (target.endsWith('/')) continue
    const baseUrl = base === 'FIXTURE_ROOT' ? fixtureRoot : pathToFileURL(abs)
    const resolved = fileURLToPath(new URL(target, baseUrl))
    checked++
    if (!existsSync(resolved)) {
      problems.push(`${rel}: new URL('${target}', ${base}) -> ${resolved} (does not exist)`)
    }
  }
}

if (problems.length > 0) {
  console.error(
    `check-bench-paths: ${problems.length} bench runtime path(s) do not resolve. A tier likely ` +
      `moved directories without updating a new URL(...) path:\n  ${problems.join('\n  ')}`
  )
  process.exit(1)
}

console.log(
  `check-bench-paths: OK (${checked} runtime path(s) across ${files.length} files resolve).`
)
