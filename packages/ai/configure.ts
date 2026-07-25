import type Configure from '@adonisjs/core/commands/configure'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import {
  publishSatellite,
  registerSatelliteInRcFile,
  printSatelliteManifest,
  readSatelliteManifest,
} from '@adonisjs-lasagna/saas-tenancy/sdk'

/**
 * `node ace configure @adonisjs-lasagna/ai` reads its own
 * `package.json#lasagnaSatellite` manifest and uses the shared toolkit so it
 * behaves identically to core's `configure --with=ai` path. The manifest points
 * `migrations` at a directory, so every stub in `stubs/migrations` publishes
 * without being listed here: today the audit chain and the action ledger.
 */
export default async function configure(command: Configure) {
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const pkgJson = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'))
  const manifest = readSatelliteManifest(pkgJson, (m) => command.logger.warning(m))
  if (!manifest) {
    command.logger.error('@adonisjs-lasagna/ai: missing or invalid lasagnaSatellite manifest')
    command.exitCode = 1
    return
  }

  const app = command.app as unknown as {
    migrationsPath?: (...p: string[]) => string
    makePath: (...p: string[]) => string
  }
  const migrationsDir =
    typeof app.migrationsPath === 'function'
      ? app.migrationsPath()
      : app.makePath('database', 'migrations')

  const codemods = await command.createCodemods()
  const { published, skipped } = await publishSatellite(
    codemods,
    { packageName: pkgJson.name, root: pkgRoot, manifest },
    migrationsDir
  )

  if (skipped.length > 0) {
    command.logger.info(`skipped already-published migrations (re-run safe): ${skipped.join(', ')}`)
  }
  command.logger.info(`published ${pkgJson.name} migrations: ${published.length}`)

  await registerSatelliteInRcFile(codemods, manifest)
  printSatelliteManifest(command.logger, manifest)
}
