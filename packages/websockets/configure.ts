import type Configure from '@adonisjs/core/commands/configure'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import {
  registerSatelliteInRcFile,
  printSatelliteManifest,
  readSatelliteManifest,
} from '@adonisjs-lasagna/saas-tenancy/sdk'

/**
 * `node ace configure @adonisjs-lasagna/websockets`. The WebSockets satellite is
 * stateless (no migrations), so configure only registers the provider in the
 * host's `adonisrc.ts` and prints the manifest. It reads its own
 * `package.json#lasagnaSatellite` so it stays in lockstep with the shared toolkit.
 */
export default async function configure(command: Configure) {
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const pkgJson = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'))
  const manifest = readSatelliteManifest(pkgJson, (m) => command.logger.warning(m))
  if (!manifest) {
    command.logger.error('websockets: missing or invalid lasagnaSatellite manifest')
    command.exitCode = 1
    return
  }

  const codemods = await command.createCodemods()
  await registerSatelliteInRcFile(codemods, manifest)
  printSatelliteManifest(command.logger, manifest)
}
