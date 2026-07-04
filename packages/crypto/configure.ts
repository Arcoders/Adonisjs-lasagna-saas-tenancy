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
 * `node ace configure @adonisjs-lasagna/crypto` reads its own
 * `package.json#lasagnaSatellite` manifest and uses the shared toolkit so it
 * behaves identically to core's `configure --with=crypto` path. It registers the
 * provider and publishes the crypto satellite's central migration stubs.
 *
 * crypto's only central stub is the SHARED rowscope wrapped-DEK table
 * (`create_crypto_wrapped_deks_rowscope`), which a host runs ONLY under the
 * `rowscope-pg` driver (see the crypto guide, "Rowscope placement"). The
 * per-tenant wrapped-DEK table is NOT a central stub: it ships inside the package
 * as a `perTenantMigrations` entry and is applied per tenant by `tenant:migrate`
 * into whatever placement the active driver reports. Crypto-shredding also needs
 * the shared `backoffice.worm_ledger` table, which the CORE WORM ledger publishes,
 * not this satellite.
 */
export default async function configure(command: Configure) {
  // configure.ts compiles to build/configure.js, so the package root (where
  // package.json + stubs/ live) is one level up.
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const pkgJson = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'))
  const manifest = readSatelliteManifest(pkgJson, (m) => command.logger.warning(m))
  if (!manifest) {
    command.logger.error('@adonisjs-lasagna/crypto: missing or invalid lasagnaSatellite manifest')
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
