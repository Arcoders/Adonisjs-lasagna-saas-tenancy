// Contract canary for @japa/runner, run as a standalone node check (NOT inside
// the tsx-driven test suites, where spawning a nested process corrupts the
// parent esbuild service).
//
// The deterministic spec ordering in @adonisjs-lasagna/satellite-test-kit
// (spec_order.ts, used by both the unit and integration runners) relies on one
// @japa/runner behaviour: when a suite's `files` is a FUNCTION, japa runs
// `await files()` and uses the returned list VERBATIM (no re-glob, no re-sort),
// so our sorted order is preserved. If a future @japa/runner version changes
// that contract, the ordering would silently stop working. This check exercises
// the REAL installed @japa/runner over two trivial specs handed back, out of
// alphabetical order, by a `files` thunk, and fails if they do not execute in
// exactly that order.
//
// Everything is plain `.mjs` run with `node` (no tsx, no esbuild, no npx): the
// temp specs import @japa/runner's built `.js` by its resolved absolute url, so
// there is no transpile step and no bare-specifier resolution to worry about.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const japaUrl = import.meta.resolve('@japa/runner')
const dir = mkdtempSync(join(tmpdir(), 'japa-thunk-canary-'))

try {
  const spec = (marker) =>
    `import { test } from '${japaUrl}'\n` +
    `test('${marker}', () => { console.log('CANARY_RAN:${marker}') })\n`
  writeFileSync(join(dir, 'a.spec.mjs'), spec('a'))
  writeFileSync(join(dir, 'b.spec.mjs'), spec('b'))
  // The thunk returns B before A on purpose: a faithful contract preserves that
  // order; a japa that re-sorts or re-globs would emit A before B.
  writeFileSync(
    join(dir, 'run.mjs'),
    `import { configure, processCLIArgs, run } from '${japaUrl}'\n` +
      `processCLIArgs([])\n` +
      `const here = new URL('.', import.meta.url)\n` +
      `configure({\n` +
      `  files: () => [new URL('b.spec.mjs', here), new URL('a.spec.mjs', here)],\n` +
      `  forceExit: true,\n` +
      `})\n` +
      `run()\n`
  )

  const result = spawnSync(process.execPath, [join(dir, 'run.mjs')], {
    encoding: 'utf8',
    timeout: 120_000,
  })

  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const iB = out.indexOf('CANARY_RAN:b')
  const iA = out.indexOf('CANARY_RAN:a')

  if (iB === -1 || iA === -1) {
    console.error(
      'check-japa-thunk-contract: one or both canary specs did not run. ' +
        'A `files: () => [...]` thunk may no longer be honored by @japa/runner.\n' +
        out
    )
    process.exit(1)
  }
  if (iB >= iA) {
    console.error(
      'check-japa-thunk-contract: @japa/runner did not preserve the files() thunk order ' +
        '(expected B before A). The deterministic-order contract that spec_order.ts relies on ' +
        'has changed; revisit run_integration_suite.ts / runner_entries.ts.\n' +
        out
    )
    process.exit(1)
  }

  console.log('check-japa-thunk-contract: OK (files() thunk order preserved).')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
