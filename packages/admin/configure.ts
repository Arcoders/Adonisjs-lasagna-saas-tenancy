import type Configure from '@adonisjs/core/commands/configure'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { printSatelliteManifest, readSatelliteManifest } from '@adonisjs-lasagna/saas-tenancy/sdk'

/**
 * `node ace configure @adonisjs-lasagna/admin` is guidance-only by design.
 *
 * Admin ships no provider, no commands and no migrations. It is mounted by
 * calling `multitenancyAdminRoutes()` inside the host's `start/routes.ts`, and
 * that call carries a required auth middleware and an optional actor resolver
 * whose correct values only the host knows. A codemod cannot safely edit a
 * routes file or guess the host's auth middleware, so this hook never mutates
 * the host. It reads its own manifest, prints the install reminder, and prints
 * the exact mount snippet plus the fail-closed and CSRF reminders for the host
 * to paste. Same honest pattern as `tenant:satellite:remove`.
 */
export default async function configure(command: Configure) {
  // build/configure.js -> package root is one level up from build/.
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const pkgJson = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'))
  const manifest = readSatelliteManifest(pkgJson, (m) => command.logger.warning(m))
  if (!manifest) {
    command.logger.error('@adonisjs-lasagna/admin: missing or invalid lasagnaSatellite manifest')
    command.exitCode = 1
    return
  }

  printSatelliteManifest(command.logger, manifest)

  const log = command.logger
  log.log('')
  log.log('Mount the admin API yourself in start/routes.ts (no file is patched):')
  log.log('')
  log.log("  import { multitenancyAdminRoutes } from '@adonisjs-lasagna/admin'")
  log.log("  import { middleware } from '#start/kernel'")
  log.log('')
  log.log('  multitenancyAdminRoutes({')
  log.log('    middleware: middleware.adminAuth(),           // REQUIRED, fails closed without it')
  log.log('    resolveAdminActor: ({ auth }) => auth.user?.id ?? null, // for impersonation')
  log.log('  })')
  log.log('')
  log.log('Reminders:')
  log.log('  - middleware is REQUIRED. Omitting it throws at startup (the surface is destructive).')
  log.log('    Pass `middleware: false` only behind a trusted network boundary.')
  log.log('  - Apply CSRF protection to these routes in the host. The admin API does not.')
  log.log('  - The OpenAPI spec and Swagger UI are gated by `middleware` unless docsAuth: false.')
  log.log('  - SSO endpoints need @adonisjs-lasagna/sso installed; without it they return 501.')
}
