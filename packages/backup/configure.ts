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
 * `node ace configure @adonisjs-lasagna/backup` registers the backup provider
 * and commands in `adonisrc.ts` and prints the install reminder. It reads its
 * own `package.json#lasagnaSatellite` manifest, the same source of truth core's
 * `configure --with=@adonisjs-lasagna/backup` path uses.
 *
 * Backup ships no migrations. It operates on the tenants' existing schemas
 * (pg_dump / pg_restore / clone / SQL import), so there is nothing to publish
 * into the host's migrations directory. The configure step is provider and
 * commands registration plus the config and env reminder.
 */
export default async function configure(command: Configure) {
  // build/configure.js -> package root is one level up from build/.
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const pkgJson = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'))
  const manifest = readSatelliteManifest(pkgJson, (m) => command.logger.warning(m))
  if (!manifest) {
    command.logger.error('@adonisjs-lasagna/backup: missing or invalid lasagnaSatellite manifest')
    command.exitCode = 1
    return
  }

  const codemods = await command.createCodemods()
  await registerSatelliteInRcFile(codemods, manifest)
  printSatelliteManifest(command.logger, manifest)

  // Backup-specific extras beyond the generic manifest.
  const log = command.logger
  log.log('')
  log.log('Backup operates on the tenants existing schemas, so no migrations are published.')
  log.log('Requires the pg client binaries on PATH (pg_dump / pg_restore / psql).')
  log.log('S3 storage is optional: install @aws-sdk/client-s3 and set the s3 block above.')
}
