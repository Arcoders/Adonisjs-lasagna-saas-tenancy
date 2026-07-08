import 'reflect-metadata'
import { Ignitor, prettyPrintError } from '@adonisjs/core'
import { configure, processCLIArgs, run } from '@japa/runner'
import {
  decideExit,
  deriveSuiteDirectories,
  isConnectionTerminated,
  resolveSpecImport,
} from './runner_logic.js'
import { resolveSuiteGlobs } from './guarantees.js'
import { resolveOrderedSpecFiles } from './spec_order.js'
import type { Baseline } from './baseline_guard.js'

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
  /**
   * Narrow the run to one or more guarantees' `integration/` leaves (e.g.
   * `['isolation']`). When set it REPLACES `suiteGlobs`; an unknown guarantee is
   * rejected loudly. Used by `test:guarantee <category>`'s integration phase,
   * which pairs it with `allowEmpty: true` (a guarantee may have only unit
   * specs). See {@link resolveSuiteGlobs}.
   */
  guaranteeFilter?: string[]
  /**
   * Extra DDL a satellite needs its shared backoffice schema to carry before any
   * spec runs, provisioned once at boot right after `ensureBackofficeSchema`. This
   * is the sanctioned "satellite DDL registration" seam: a satellite whose SHARED
   * backoffice table is not part of the kit's core mirror (e.g. a satellite-owned
   * `backoffice.*` table) registers it here instead of hand-provisioning it in
   * every spec. Must be idempotent (the suite boots one app; the hook runs once).
   * Append-only per-spec tables that need a clean slate between groups (crypto's
   * WORM ledger, AI's audit log) still provision + drop themselves per group and do
   * NOT use this hook.
   */
  extraSchemaSetup?: () => Promise<void>
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
  const suiteGlobs = resolveSuiteGlobs({
    suiteGlobs: options.suiteGlobs ?? ['tests/integration/**/*.spec.ts'],
    guaranteeFilter: options.guaranteeFilter,
  })
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
      // process-level singletons (the config, the tenant resolver registry, the
      // resolution caches). These guards snapshot the boot baseline on the first
      // group and restore any that a group left drifted, so one spec's leaked
      // mutation can never poison the next (Japa runs files in undefined order).
      // The emits are not awaited, so the handlers must be synchronous; capture
      // and restore are sync, so they are (any async work, like resolving a
      // container singleton, happens here while building the baseline).
      const { getConfig, setConfig } = await import('@adonisjs-lasagna/saas-tenancy/config')
      const { createBaselineGuards } = await import('./baseline_guard.js')
      const baselines: Baseline<unknown>[] = [
        {
          name: 'multitenancy config',
          capture: () => getConfig() as unknown,
          // A correct restore re-installs the same frozen baseline object, so an
          // identity difference is a real, un-restored swap.
          equals: (a, b) => Object.is(a, b),
          restore: (baseline) => setConfig(baseline as never),
        },
      ]
      // Auto-load core's resolver-state baseline (registry chain + module caches)
      // the same way the config baseline is loaded: best-effort, post-boot, via a
      // core subpath. A non-core fixture without the export is simply skipped.
      try {
        const internal = (await import('@adonisjs-lasagna/saas-tenancy/internal')) as {
          createResolverStateBaseline?: (app: unknown) => Promise<Baseline<unknown>>
        }
        if (typeof internal.createResolverStateBaseline === 'function') {
          baselines.push(await internal.createResolverStateBaseline(app))
        }
      } catch {
        // Fixture is not core / does not expose the resolver baseline; skip it.
      }
      const baselineGuard = createBaselineGuards(baselines, (message) => console.warn(message))
      const configBaselinePlugin = ({ emitter }: { emitter: any }): void => {
        emitter.on('group:start', () => baselineGuard.onGroupStart())
        emitter.on('group:end', (payload: { title?: string }) =>
          baselineGuard.onGroupEnd(payload?.title ?? '(unknown group)')
        )
      }

      processCLIArgs(process.argv.splice(2))
      // Rewrite the suite globs to be cwd-relative. The fixture rcFile uses
      // package-relative paths so the AdonisJS test command (cwd at the fixture
      // root) can find them; our runner spawns from the calling package root,
      // where the same glob would point elsewhere. We mutate the suite
      // definition rather than adding a top-level `files` list so the
      // suite-level `configureSuite` hook still applies.
      // Resolve the globs to a deterministically sorted file list (a `files`
      // thunk), instead of letting japa fast-glob them in arbitrary order. Stable
      // order makes the run reproducible and immune to directory-tree changes,
      // which is what turns a cross-spec state leak from intermittent into
      // catchable. The thunk form returns file URLs verbatim (see spec_order.ts).
      const orderedFiles = (): Promise<URL[]> => resolveOrderedSpecFiles(suiteGlobs, process.cwd())
      const suites = (app.rcFile.tests.suites ?? []).map((s) => ({
        ...s,
        files: orderedFiles,
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
        // ensureBackofficeSchema first, then any satellite-registered shared DDL.
        setup: options.extraSchemaSetup
          ? runnerHooks.setup.concat([options.extraSchemaSetup])
          : runnerHooks.setup,
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
