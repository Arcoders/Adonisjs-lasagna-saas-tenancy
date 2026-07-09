process.env.NODE_ENV = 'test'

import 'reflect-metadata'
import { Ignitor, prettyPrintError } from '@adonisjs/core'
import { configure, processCLIArgs, run } from '@japa/runner'

const APP_ROOT = new URL('../', import.meta.url)
const IMPORTER = (filePath: string) => {
  if (filePath.startsWith('./') || filePath.startsWith('../')) {
    return import(new URL(filePath, APP_ROOT).href)
  }
  return import(filePath)
}

new Ignitor(APP_ROOT, { importer: IMPORTER })
  .tap((app) => {
    app.booting(async () => {
      await import('#start/env')
    })
    app.listen('SIGTERM', () => app.terminate())
    app.listenIf(app.managedByPm2, 'SIGINT', () => app.terminate())
  })
  .testRunner()
  .configure(async (app) => {
    processCLIArgs(process.argv.splice(2))
    const { plugins, configureSuite } = await import('#tests/bootstrap')
    // `plugins` / `configureSuite` are optional on Japa's `Config`; omit each
    // key when the bootstrap leaves it undefined instead of passing `undefined`.
    configure({
      ...app.rcFile.tests,
      ...(plugins !== undefined ? { plugins } : {}),
      ...(configureSuite !== undefined ? { configureSuite } : {}),
    })
  })
  .run(() => run())
  .catch(async (error) => {
    process.exitCode = 1
    await prettyPrintError(error)
  })
