/**
 * Boot the bench fixture as a headless AdonisJS app for tiers 2 and 4.
 *
 * The isolation drivers lazy-import `@adonisjs/lucid/services/db` (which awaits
 * `app.booted(...)`) and read `getConfig()` (populated only by the multitenancy
 * provider's boot). So anything that touches the DB needs a fully booted +
 * started app, not bare imports. This mirrors the bootstrap shape of the core
 * integration runner (packages/core/bin/test.integration.ts) but with no HTTP
 * listener and no test runner: just init, then boot, then start.
 */
import 'reflect-metadata'
import { Ignitor } from '@adonisjs/core'
import type { ApplicationService } from '@adonisjs/core/types'
import { fileURLToPath } from 'node:url'

/** Root of the bench fixture app (the dir holding adonisrc + bin/). */
export const FIXTURE_ROOT = new URL('../../fixture/', import.meta.url)

/**
 * Absolute path to the fixture's HTTP server entry. Single-sourced here, derived
 * from FIXTURE_ROOT, so the tiers that spawn the server (http, isolation,
 * resilience) never recompute a `../fixture` / `../../fixture` relative path that
 * silently breaks when a tier moves between directory depths.
 */
export const FIXTURE_SERVER_ENTRY = fileURLToPath(new URL('bin/server.ts', FIXTURE_ROOT))

const IMPORTER = (filePath: string) => {
  if (filePath.startsWith('./') || filePath.startsWith('../')) {
    return import(new URL(filePath, FIXTURE_ROOT).href)
  }
  return import(filePath)
}

export async function bootBenchApp(): Promise<ApplicationService> {
  const ignitor = new Ignitor(FIXTURE_ROOT, { importer: IMPORTER }).tap((app) => {
    app.booting(async () => {
      await IMPORTER('./start/env.js')
    })
  })

  const app = ignitor.createApp('web')
  await app.init()
  await app.boot()
  await app.start(async () => {})
  return app
}

export async function terminateBenchApp(app: ApplicationService): Promise<void> {
  try {
    await app.terminate()
  } catch {
    // Lucid can reject an in-flight query with "Connection terminated" while
    // draining the pool on shutdown; harmless once we've decided to exit.
  }
}

/** Resolve the live Lucid `db` service from a booted bench app. */
export async function getDb() {
  const { default: db } = await import('@adonisjs/lucid/services/db')
  return db
}
