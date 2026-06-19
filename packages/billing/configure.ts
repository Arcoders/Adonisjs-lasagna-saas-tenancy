import type Configure from '@adonisjs/core/commands/configure'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, access } from 'node:fs/promises'
import {
  publishSatellite,
  registerSatelliteInRcFile,
  printSatelliteManifest,
  readSatelliteManifest,
} from '@adonisjs-lasagna/saas-tenancy/sdk'

const fileExists = (p: string) =>
  access(p)
    .then(() => true)
    .catch(() => false)

/**
 * `node ace configure @adonisjs-lasagna/billing` — publish the billing
 * satellite's migrations + the quota-warning mailer/view, register its provider
 * + commands in `adonisrc.ts`, and print the install reminder. Reads its own
 * `package.json#lasagnaSatellite` manifest, the same source of truth core's
 * `configure --with=@adonisjs-lasagna/billing` path uses.
 */
export default async function configure(command: Configure) {
  // build/configure.js → package root is one level up from build/.
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const stubsRoot = join(pkgRoot, 'stubs')
  const pkgJson = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'))
  const manifest = readSatelliteManifest(pkgJson, (m) => command.logger.warning(m))
  if (!manifest) {
    command.logger.error('@adonisjs-lasagna/billing: missing or invalid lasagnaSatellite manifest')
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

  // Migrations (idempotent, namespaced by package). billing requires the core
  // `quotas` bundle for tenant_plans — the manifest declares it; this hook
  // prints the prerequisite.
  const { published, skipped } = await publishSatellite(
    codemods,
    { packageName: pkgJson.name, root: pkgRoot, manifest },
    migrationsDir
  )
  if (skipped.length > 0) {
    command.logger.info(`skipped already-published migrations (re-run safe): ${skipped.join(', ')}`)
  }
  command.logger.info(`published @adonisjs-lasagna/billing migrations: ${published.length}`)

  // Mailer + view so QuotaExceededBillingListener has something to dispatch out
  // of the box. Never overwrite the host's own copy.
  const mailerPath = command.app.makePath('app/mailers/quota_warning_mailer.ts')
  if (!(await fileExists(mailerPath))) {
    await codemods.makeUsingStub(stubsRoot, 'mailers/quota_warning_mailer.stub', {})
  } else {
    command.logger.info('skipping app/mailers/quota_warning_mailer.ts — already exists')
  }

  const viewPath = command.app.makePath('resources/views/emails/quota_warning.edge')
  if (!(await fileExists(viewPath))) {
    await codemods.makeUsingStub(stubsRoot, 'views/emails/quota_warning.edge.stub', {})
  } else {
    command.logger.info('skipping resources/views/emails/quota_warning.edge — already exists')
  }

  // Register provider + commands in adonisrc.ts (idempotent codemod).
  await registerSatelliteInRcFile(codemods, manifest)

  // Install / env / config reminder (shared with the core --with= path).
  printSatelliteManifest(command.logger, manifest)

  // Billing-specific extras beyond the generic manifest.
  const log = command.logger
  log.log('')
  log.log('Drivers: Stripe (npm install stripe@^22, optional peer); Paddle / Lemon Squeezy')
  log.log('  (built-in REST drivers — no SDK).')
  log.log('Wire the webhook route in start/routes.ts:')
  log.log("  import { multitenancyBillingRoutes } from '@adonisjs-lasagna/billing'")
  log.log('  multitenancyBillingRoutes()')
}
