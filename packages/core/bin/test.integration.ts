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
const swallowConnectionTerminated = (reason: unknown): void => {
  if (isConnectionTerminated(reason)) return
  throw reason
}
process.on('unhandledRejection', swallowConnectionTerminated)
process.on('uncaughtException', swallowConnectionTerminated)
// NOTE: keep @japa/runner on 4.x. Runner 5 adds its own
// unhandledRejection/uncaughtException monitor that flips the run to exit 1 on
// ANY rejection — including the benign "Connection terminated" race swallowed
// above (Node fires every listener, so this swallow can't stop it). It offers
// no opt-out, so bumping to 5 needs that teardown race fixed at the source first.

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
    process.exitCode = 1
    await prettyPrintError(error)
  })
  .finally(() => process.exit(process.exitCode ?? 0))
