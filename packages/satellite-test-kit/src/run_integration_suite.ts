import 'reflect-metadata'
import { Ignitor, prettyPrintError } from '@adonisjs/core'
import { configure, processCLIArgs, run } from '@japa/runner'
import {
  decideExit,
  deriveSuiteDirectories,
  isConnectionTerminated,
  resolveSpecImport,
} from './runner_logic.js'

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
  /**
   * When true, a suite that matched zero spec files exits 0 instead of failing.
   * Default false: a no-file-matched glob is almost always a broken
   * `suiteGlobs`/`cwd`. Self-skipping specs (`test.skip(...)`) still count in
   * japa's `aggregates.total`, so the default does not affect key-gated smoke
   * suites (e.g. `BILLING_OPTIONAL_SMOKES_ONLY`).
   */
  allowEmpty?: boolean
}

/**
 * Run an AdonisJS integration suite for the calling package. This owns the
 * single, fragile exit-code recompute: @japa/runner's exceptions monitor flips
 * the run to exit 1 on ANY unhandled rejection, including the benign
 * "Connection terminated" teardown race (see `isConnectionTerminated` in
 * `runner_logic.ts`). We do not fight japa's listener; we let it set its exit
 * code, then recompute the FINAL exit code in `.finally` via `decideExit` from
 * real signals only. For that `.finally` to run, `forceExit` must be off in the
 * `configure()` call below (the fixture rc may turn it on; we override it).
 */
export async function runIntegrationSuite(options: RunIntegrationSuiteOptions): Promise<void> {
  process.env.NODE_ENV = 'test'

  const FIXTURE_ROOT = options.fixtureRoot
  const suiteGlobs = options.suiteGlobs ?? ['tests/integration/**/*.spec.ts']
  const suiteDirectories = deriveSuiteDirectories(suiteGlobs)

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
  let capturedRunner:
    | { getSummary(): { hasError: boolean; aggregates: { total: number } } }
    | undefined
  let runnerEnded = false
  const captureRunner = ({ runner, emitter }: { runner: any; emitter: any }): void => {
    capturedRunner = runner
    emitter.on('runner:end', () => {
      runnerEnded = true
    })
  }

  const IMPORTER = (filePath: string) => import(resolveSpecImport(filePath, FIXTURE_ROOT))

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

      // Isolation backstop: the suite boots one app, so every spec shares the
      // config singleton. This guard snapshots the boot config on the first group
      // and restores it after any group that left it swapped, so one spec's leaked
      // `setConfig` can never poison the next (Japa runs files in undefined order).
      // The emits are not awaited, so the handlers must be synchronous; restoring
      // the config is sync, so they are.
      const { getConfig, setConfig } = await import('@adonisjs-lasagna/saas-tenancy/config')
      const { createConfigBaselineGuard } = await import('./config_baseline.js')
      const configGuard = createConfigBaselineGuard({
        getConfig,
        setConfig,
        warn: (message) => console.warn(message),
      })
      const configBaselinePlugin = ({ emitter }: { emitter: any }): void => {
        emitter.on('group:start', () => configGuard.onGroupStart())
        emitter.on('group:end', (payload: { title?: string }) =>
          configGuard.onGroupEnd(payload?.title ?? '(unknown group)')
        )
      }

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
        plugins: [...(plugins ?? []), captureRunner, configBaselinePlugin],
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
      // Read the authoritative test summary; an unreadable summary stays
      // undefined and decideExit preserves japa's own exit code.
      let summary: { hasError: boolean; aggregates: { total: number } } | undefined
      try {
        summary = capturedRunner?.getSummary()
      } catch {
        summary = undefined
      }

      const { code, reason } = decideExit({
        sawNonBenignProcessError,
        runnerEnded,
        summary,
        currentExitCode: Number(process.exitCode ?? 0),
        allowEmpty: options.allowEmpty ?? false,
        suiteGlobs,
        fixtureRoot: FIXTURE_ROOT.href,
        cwd: process.cwd(),
      })

      if (process.env.LASAGNA_TESTKIT_DEBUG) {
        console.error('[testkit] fixtureRoot=%s', FIXTURE_ROOT.href)
        console.error('[testkit] suiteGlobs=%o directories=%o', suiteGlobs, suiteDirectories)
        console.error(
          '[testkit] aggregates.total=%o runnerEnded=%o',
          summary?.aggregates.total,
          runnerEnded
        )
        console.error('[testkit] exit=%o reason=%s', code, reason ?? '(none)')
      }

      if (reason) console.error(reason)
      process.exit(code)
    })
}
