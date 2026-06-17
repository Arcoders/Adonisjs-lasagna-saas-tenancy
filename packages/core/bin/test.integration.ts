process.env.NODE_ENV = 'test'

import 'reflect-metadata'
import { Ignitor, prettyPrintError } from '@adonisjs/core'
import { configure, processCLIArgs, run } from '@japa/runner'

const FIXTURE_ROOT = new URL('../tests/fixtures/', import.meta.url)

// Lucid drains the pg pool whenever a connection is released. That happens at
// `app.terminate()`, but also when a per-tenant pool idle-closes or a schema is
// dropped in a group teardown mid-suite (the cross_tenant_e2e concurrency spec
// is a frequent trigger). A query in flight at that moment rejects with
// `Error: Connection terminated` (pg/lib/client.js:180, from the socket `end`
// listener), and pg surfaces the same condition on the Client `'error'` event
// when no query is queued. The originating caller is almost always a
// fire-and-forget DB write from an event listener whose handler returned before
// the write resolved, so the rejection has no `.catch()` and Node escalates it
// to the process, flipping the exit code to 1 even though every test passed.
//
// This is never a real test signal. A query a test depends on is awaited and
// fails that test's assertion directly; only orphaned, un-awaited writes reach
// these process-level handlers. So we swallow this one specific error wherever
// it fires and rethrow everything else. (It used to be gated on a shutdown flag
// set in the final teardown, which missed the same race firing during an
// earlier group teardown, the failure mode this replaces.)
const isConnectionTerminated = (reason: unknown): boolean => {
  const message =
    reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : ''
  return /^Connection terminated/.test(message)
}

// @japa/runner 4.5's exceptions monitor flips the run to exit 1 on ANY unhandled
// rejection — including the benign "Connection terminated" race above — and Node
// fires every process listener, so a swallowing handler here cannot stop japa
// from also seeing it and failing the run. (Despite the older note, this monitor
// is NOT 5.x-only; it landed within the 4.x line.) So we don't fight japa's
// listener: we let it set its exit code, then recompute the FINAL exit code in
// `.finally` from real signals only. A process-level error that is NOT the
// benign race is tracked here and always fails the run.
let sawNonBenignProcessError = false
const onProcessError = (reason: unknown): void => {
  if (isConnectionTerminated(reason)) return
  sawNonBenignProcessError = true
  // We're about to fail the run; surface the cause instead of hiding it.
  console.error(reason)
}
process.on('unhandledRejection', onProcessError)
process.on('uncaughtException', onProcessError)

// Captured so `.finally` can read the authoritative test result. `runner:end`
// fires only when execution reached a clean end — it does NOT fire when a
// setup/exec error trips run()'s internal catch — so it doubles as proof the
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

new Ignitor(FIXTURE_ROOT, { importer: IMPORTER })
  .tap((app) => {
    app.booting(async () => {
      await IMPORTER('./start/env.js')
    })
    app.listen('SIGTERM', () => app.terminate())
    app.listenIf(app.managedByPm2, 'SIGINT', () => app.terminate())
  })
  .testRunner()
  .configure(async (app) => {
    const { runnerHooks, ...config } = await import('../tests/integration/bootstrap.js')

    processCLIArgs(process.argv.splice(2))
    // Rewrite the suite globs to be cwd-relative. The rcFile uses
    // `'../../tests/...'` so the AdonisJS test command (run with cwd at
    // the fixture root) can find them, but our runner spawns from the
    // repo root, where the same glob would point outside the package.
    // We mutate the suite definition rather than adding a top-level
    // `files` list so the suite-level `configureSuite` hook (which boots
    // the test HTTP server) still applies.
    const suites = (app.rcFile.tests.suites ?? []).map((s) => ({
      ...s,
      files: ['tests/integration/**/*.spec.ts'],
      directories: ['tests/integration'],
    }))
    configure({
      ...app.rcFile.tests,
      ...config,
      plugins: [...(config.plugins ?? []), captureRunner],
      suites,
      ...{
        setup: runnerHooks.setup,
        teardown: runnerHooks.teardown.concat([
          async () => {
            await app.terminate()
          },
        ]),
      },
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

    // Downgrade japa's exit code to 0 ONLY when the run reached a clean end with
    // every test passing — i.e. the lingering exit-1 can only be the benign
    // "Connection terminated" teardown race. Test failures (summaryHasError) and
    // early aborts (runnerEnded === false, e.g. a setup/exec throw) keep the
    // failure via japa's own exit code.
    const ranClean = runnerEnded && summaryHasError === false
    process.exit(ranClean ? 0 : (process.exitCode ?? 0))
  })
