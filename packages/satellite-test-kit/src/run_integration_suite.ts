import 'reflect-metadata'
import { Ignitor, prettyPrintError } from '@adonisjs/core'
import { configure, processCLIArgs, run } from '@japa/runner'

export interface RunIntegrationSuiteOptions {
  /**
   * Absolute URL of the AdonisJS fixture app root (the directory holding
   * `adonisrc.ts`/`adonisrc.js`). Boot happens here. The shared canonical
   * fixture lives in this package; core and each satellite pass it (or, during
   * the migration, their own) so there is one Ignitor boot path.
   */
  fixtureRoot: URL
  /**
   * Suite globs, relative to the calling package's cwd (where `tsx` was invoked).
   * Defaults to the satellite convention `tests/integration/**\/*.spec.ts`. The
   * rcFile globs are rewritten to these so the suite-level `configureSuite` hook
   * (which starts the test HTTP server) still applies.
   */
  suiteGlobs?: string[]
}

// Lucid drains the pg pool whenever a connection is released. That happens at
// `app.terminate()`, but also when a per-tenant pool idle-closes or a schema is
// dropped in a group teardown mid-suite. A query in flight at that moment
// rejects with `Error: Connection terminated` (pg/lib/client.js, from the socket
// `end` listener), and pg surfaces the same condition on the Client `'error'`
// event when no query is queued. The originating caller is almost always a
// fire-and-forget DB write from an event listener whose handler returned before
// the write resolved, so the rejection has no `.catch()` and Node escalates it
// to the process, flipping the exit code to 1 even though every test passed.
//
// This is never a real test signal. A query a test depends on is awaited and
// fails that test's assertion directly; only orphaned, un-awaited writes reach
// these process-level handlers. So we swallow this one specific error wherever
// it fires and rethrow everything else.
const isConnectionTerminated = (reason: unknown): boolean => {
  const message =
    reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : ''
  return /^Connection terminated/.test(message)
}

/**
 * Run an AdonisJS integration suite for the calling package. This owns the
 * single, fragile exit-code recompute: @japa/runner's exceptions monitor flips
 * the run to exit 1 on ANY unhandled rejection, including the benign
 * "Connection terminated" teardown race above. We do not fight japa's listener;
 * we let it set its exit code, then recompute the FINAL exit code in `.finally`
 * from real signals only. For that `.finally` to run, `forceExit` must be off in
 * the `configure()` call below (the fixture rc may turn it on; we override it).
 */
export async function runIntegrationSuite(options: RunIntegrationSuiteOptions): Promise<void> {
  process.env.NODE_ENV = 'test'

  const FIXTURE_ROOT = options.fixtureRoot
  const suiteGlobs = options.suiteGlobs ?? ['tests/integration/**/*.spec.ts']
  // Strip a trailing `/**/*.spec.ts` (or similar) to derive the suite
  // directories, mirroring core's rewrite. Fall back to `tests/integration`.
  const suiteDirectories = suiteGlobs.map((g) => g.replace(/\/\*\*.*$/, '')) ?? [
    'tests/integration',
  ]

  let sawNonBenignProcessError = false
  const onProcessError = (reason: unknown): void => {
    if (isConnectionTerminated(reason)) return
    sawNonBenignProcessError = true
    // We are about to fail the run; surface the cause instead of hiding it.
    console.error(reason)
  }
  process.on('unhandledRejection', onProcessError)
  process.on('uncaughtException', onProcessError)

  // Captured so `.finally` can read the authoritative test result. `runner:end`
  // fires only when execution reached a clean end (it does NOT fire when a
  // setup/exec error trips run()'s internal catch), so it doubles as proof the
  // run completed rather than aborting early.
  let capturedRunner: { getSummary(): { hasError: boolean } } | undefined
  let runnerEnded = false
  const captureRunner = ({ runner, emitter }: { runner: any; emitter: any }): void => {
    capturedRunner = runner
    emitter.on('runner:end', () => {
      runnerEnded = true
    })
  }

  const IMPORTER = (filePath: string) => {
    if (filePath.startsWith('./') || filePath.startsWith('../')) {
      return import(new URL(filePath, FIXTURE_ROOT).href)
    }
    return import(filePath)
  }

  await new Ignitor(FIXTURE_ROOT, { importer: IMPORTER })
    .tap((app) => {
      app.booting(async () => {
        await IMPORTER('./start/env.js')
      })
      app.listen('SIGTERM', () => app.terminate())
      app.listenIf(app.managedByPm2, 'SIGINT', () => app.terminate())
    })
    .testRunner()
    .configure(async (app) => {
      const { plugins, runnerHooks, configureSuite } = await import('./bootstrap.js')

      processCLIArgs(process.argv.splice(2))
      // Rewrite the suite globs to be cwd-relative. The fixture rcFile uses
      // package-relative paths so the AdonisJS test command (cwd at the fixture
      // root) can find them; our runner spawns from the calling package root,
      // where the same glob would point elsewhere. We mutate the suite
      // definition rather than adding a top-level `files` list so the
      // suite-level `configureSuite` hook still applies.
      const suites = (app.rcFile.tests.suites ?? []).map((s) => ({
        ...s,
        files: suiteGlobs,
        directories: suiteDirectories,
      }))
      configure({
        ...app.rcFile.tests,
        configureSuite,
        // The fixture's adonisrc may set `forceExit: true`. That makes
        // @japa/runner call `process.exit()` from inside run() the instant it
        // computes an exit code, before the `.finally` below runs, making the
        // whole exit-code recompute dead code. Force it OFF so run() resolves
        // normally and `.finally` becomes the single authoritative exit point.
        // The `.finally` always calls `process.exit()` itself, so we keep
        // forceExit's "never hang on an open pg handle" guarantee.
        forceExit: false,
        plugins: [...(plugins ?? []), captureRunner],
        suites,
        setup: runnerHooks.setup,
        teardown: runnerHooks.teardown.concat([
          async () => {
            await app.terminate()
          },
        ]),
      })
    })
    .run(() => run())
    .catch(async (error) => {
      sawNonBenignProcessError = true
      await prettyPrintError(error)
    })
    .finally(() => {
      // A non-benign process error (or a rejected run) always fails.
      if (sawNonBenignProcessError) process.exit(1)

      let summaryHasError: boolean | undefined
      try {
        summaryHasError = capturedRunner?.getSummary().hasError
      } catch {
        summaryHasError = undefined
      }

      // Downgrade japa's exit code to 0 ONLY when the run reached a clean end
      // with every test passing: the lingering exit-1 can then only be the
      // benign "Connection terminated" teardown race. Test failures
      // (summaryHasError) and early aborts (runnerEnded === false, e.g. a
      // setup/exec throw) keep the failure via japa's own exit code.
      const ranClean = runnerEnded && summaryHasError === false
      process.exit(ranClean ? 0 : (process.exitCode ?? 0))
    })
}
