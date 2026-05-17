process.env.NODE_ENV = 'test'

import 'reflect-metadata'
import { Ignitor, prettyPrintError } from '@adonisjs/core'
import { configure, processCLIArgs, run } from '@japa/runner'

const FIXTURE_ROOT = new URL('../tests/fixtures/', import.meta.url)

// Once the suite finishes and we call `app.terminate()`, Lucid drains the
// pg pool. Any query that was queued at that exact moment rejects with
// `Error: Connection terminated` (pg/lib/client.js:180, fired from the
// socket `end` listener). The originating caller is already gone — most
// often a fire-and-forget DB write from an event listener whose handler
// returned before the write resolved — so the rejection has no `.catch()`
// and Node flips the process exit code to 1 even though every test
// passed. Swallow this *specific* error only after we've started the
// shutdown handshake; anything else still surfaces as a real failure.
let isShuttingDown = false
const isConnectionTerminated = (reason: unknown): boolean => {
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : ''
  return /^Connection terminated/.test(message)
}
process.on('unhandledRejection', (reason) => {
  if (isShuttingDown && isConnectionTerminated(reason)) return
  throw reason
})
// Same root cause as the unhandledRejection above, but pg surfaces it
// via the Client's `'error'` event when no query is queued — with no
// listener, Node escalates to uncaughtException and the process exits 1
// even though every test passed.
process.on('uncaughtException', (err) => {
  if (isShuttingDown && isConnectionTerminated(err)) return
  throw err
})

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
            isShuttingDown = true
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
