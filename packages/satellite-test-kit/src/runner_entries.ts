// Thin unit-suite runner entry shared by every package's `bin/test.ts`, so the
// 6+ byte-identical copies collapse to one call and the harness globs live in a
// single place (`guarantees.ts`). Side-effectful (calls `run()`); like
// `run_integration_suite.ts` it is NOT in the kit's coverage include: its only
// logic is the glob selection, which is unit-tested in `guaranteeGlobs`.
//
// Boot-safe: imports only `@japa/runner` / `@japa/assert` (no `@adonisjs/*`
// service touches `app.booted` at import time), and is reached from the no-build
// unit loop via a relative source path.

import { configure, processCLIArgs, run } from '@japa/runner'
import { assert } from '@japa/assert'
import { guaranteeGlobs, type GuaranteeGlobsOptions } from './guarantees.js'
import { resolveOrderedSpecFiles } from './spec_order.js'

/**
 * Run a package's unit suite: the guarantee unit-leaf specs plus, when
 * `withArchitecture` is set, the architecture specs (globs from
 * {@link guaranteeGlobs}).
 *
 * Files are resolved through {@link resolveOrderedSpecFiles} so the run order is
 * deterministic (sorted), matching the integration runner; passing a `files`
 * thunk bypasses japa's unsorted fast-glob discovery while keeping its default
 * file-URL contract.
 *
 * No `reporters` is passed on purpose. Japa's default is already the spec
 * reporter (spec locally, spec+github under GitHub Actions, dot under an AI
 * agent); forcing `activated: ['spec']` would drop the CI GitHub annotations,
 * and there is no `@japa/spec-reporter` plugin in this repo to import.
 */
export function runUnitSuite(options: GuaranteeGlobsOptions = {}): void {
  processCLIArgs(process.argv.splice(2))
  const globs = guaranteeGlobs(options).unit
  configure({
    files: () => resolveOrderedSpecFiles(globs, process.cwd()),
    plugins: [assert()],
  })
  run()
}
