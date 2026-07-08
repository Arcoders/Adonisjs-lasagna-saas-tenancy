import type Configure from '@adonisjs/core/commands/configure'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import {
  printSatelliteManifest,
  readSatelliteManifest,
  registerSatelliteInRcFile,
} from '@adonisjs-lasagna/saas-tenancy/sdk'

/**
 * `node ace configure @adonisjs-lasagna/admin` registers the backstop provider and
 * is otherwise guidance-only by design.
 *
 * Admin ships a minimal `definePlugin` provider whose only job is the runtime ABI +
 * plugin-API backstop (it binds no seams). Registering a provider in `adonisrc.ts`
 * is a safe, idempotent codemod, so this hook wires it — that is what makes every
 * satellite in the fleet assert the plugin contract uniformly at boot.
 *
 * Everything else stays guidance-only: the admin API is mounted by calling
 * `multitenancyAdminRoutes()` inside the host's `start/routes.ts`, and that call
 * carries a required auth middleware and an optional actor resolver whose correct
 * values only the host knows. A codemod cannot safely edit a routes file or guess
 * the host's auth middleware, so this hook never mutates the routes. It prints the
 * exact mount snippet plus the fail-closed and CSRF reminders for the host to
 * paste. Same honest pattern as `tenant:satellite:remove`.
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

  // Register the backstop provider in adonisrc.ts (idempotent). This is the only
  // host file this hook mutates — the routes stay a printed reminder below.
  const codemods = await command.createCodemods()
  await registerSatelliteInRcFile(codemods, manifest)

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
