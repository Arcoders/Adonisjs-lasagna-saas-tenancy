// Pure decision logic for the integration runner, extracted so it is
// unit-testable WITHOUT an Ignitor and SAFE to import before the app boots.
//
// This module imports nothing from `@adonisjs/*`, lucid, the app, or `@japa/*`.
// That is the same discipline behind reporting's `guard.ts`/`validate.ts`: the
// app-service modules top-level-`await app.booted(...)` and throw when imported
// pre-boot, so the fragile bits of `run_integration_suite.ts` live here as plain
// functions over plain values.

/**
 * Minimal structural shape of japa's `RunnerSummary` (`@japa/core`). Declared
 * locally so this module stays dependency-free; the caller passes the result of
 * `runner.getSummary()`, which is structurally compatible. `aggregates.total`
 * counts every registered test including skipped/todo ones.
 */
export interface SummaryLike {
  hasError: boolean
  aggregates: { total: number }
}

/**
 * Lucid drains the pg pool whenever a connection is released. That happens at
 * `app.terminate()`, but also when a per-tenant pool idle-closes or a schema is
 * dropped in a group teardown mid-suite. A query in flight at that moment
 * rejects with `Error: Connection terminated` (pg/lib/client.js, from the socket
 * `end` listener), and pg surfaces the same condition on the Client `'error'`
 * event when no query is queued. The originating caller is almost always a
 * fire-and-forget DB write from an event listener whose handler returned before
 * the write resolved, so the rejection has no `.catch()` and Node escalates it
 * to the process, flipping the exit code to 1 even though every test passed.
 *
 * This is never a real test signal. A query a test depends on is awaited and
 * fails that test's assertion directly; only orphaned, un-awaited writes reach
 * the process-level handlers. So callers swallow this one specific error wherever
 * it fires and rethrow everything else.
 */
export function isConnectionTerminated(reason: unknown): boolean {
  const message =
    reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : ''
  return /^Connection terminated/.test(message)
}

/**
 * Derive the suite directories from the suite globs by stripping a trailing
 * `/**...` segment, mirroring core's rewrite. A leading-slash glob such as
 * `/**\/*.spec.ts` strips to an empty string; fall back to `tests/integration`
 * in that case so the suite definition keeps a usable directory.
 */
export function deriveSuiteDirectories(globs: string[]): string[] {
  return globs.map((glob) => {
    const stripped = glob.replace(/\/\*\*.*$/, '')
    return stripped === '' ? 'tests/integration' : stripped
  })
}

/**
 * Classify a spec path into the specifier the runner should `import()`. A
 * `./`- or `../`-relative path resolves against the fixture root (the spec lives
 * in the calling package, but the importer runs from the fixture); a bare
 * specifier (a third-party or peer module) is imported as-is. Returns the
 * string to import so this stays pure; the caller wraps it in `import(...)`.
 */
export function resolveSpecImport(filePath: string, fixtureRoot: URL): string {
  if (filePath.startsWith('./') || filePath.startsWith('../')) {
    return new URL(filePath, fixtureRoot).href
  }
  return filePath
}

/**
 * Fold the final process exit code from real signals only. @japa/runner's
 * exceptions monitor flips the run to exit 1 on ANY unhandled rejection,
 * including the benign "Connection terminated" teardown race, so the caller lets
 * japa set its code and then calls this to recompute the authoritative one.
 *
 * Order matters: the zero-tests guard must precede the clean-pass downgrade,
 * because a run with 0 tests also reports `hasError:false` and would otherwise be
 * downgraded to exit 0 (a silent green on a broken `suiteGlobs`/`cwd`).
 */
export function decideExit(input: {
  sawNonBenignProcessError: boolean
  runnerEnded: boolean
  summary: SummaryLike | undefined
  currentExitCode: number
  allowEmpty: boolean
  suiteGlobs: string[]
  fixtureRoot: string
  cwd: string
}): { code: number; reason?: string } {
  const { sawNonBenignProcessError, runnerEnded, summary, currentExitCode, allowEmpty } = input

  // A non-benign process error (or a rejected run) always fails.
  if (sawNonBenignProcessError) return { code: 1 }

  // Fail loud when the run completed but matched zero specs. Self-skipping specs
  // still register (they count in aggregates.total), so this only trips on a
  // glob that matched no files.
  if (runnerEnded && summary !== undefined && summary.aggregates.total === 0 && !allowEmpty) {
    return {
      code: 1,
      reason:
        `satellite-test-kit: 0 tests ran. No spec matched ${input.suiteGlobs.join(', ')} ` +
        `from ${input.cwd} (fixtureRoot ${input.fixtureRoot}). ` +
        `Check suiteGlobs/fixtureRoot, or pass allowEmpty:true.`,
    }
  }

  // Downgrade japa's exit code to 0 only when the run reached a clean end with
  // every test passing: the lingering exit-1 can then only be the benign
  // "Connection terminated" teardown race.
  if (runnerEnded && summary !== undefined && summary.hasError === false) {
    return { code: 0 }
  }

  // Test failures (hasError), early aborts (runnerEnded false), or an unreadable
  // summary keep japa's own exit code.
  return { code: currentExitCode }
}
