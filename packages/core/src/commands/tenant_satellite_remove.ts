import { BaseCommand, args } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { discoverSatellites, indexSatellites, migrationSlug } from '../sdk/configure_kit.js'

/**
 * Print a safe, manual checklist for removing a packaged satellite.
 *
 * Why guidance, not automation: the AdonisJS codemods API can ADD a provider /
 * command to `adonisrc.ts` but has no sanctioned removal, and migrations that
 * have run own real tenant data. So this command never mutates the app — it
 * computes exactly what to remove (the provider/command lines, the published
 * migrations, the config block, the npm package) and prints it, so the operator
 * removes it deliberately. `configure` itself is idempotent, so a half-finished
 * configure is recovered by re-running it; this command covers the inverse.
 */
export default class TenantSatelliteRemove extends BaseCommand {
  static readonly commandName = 'tenant:satellite:remove'
  static readonly description =
    'Print a safe checklist for removing a packaged satellite (does not auto-edit adonisrc.ts or drop data)'
  static readonly options: CommandOptions = { startApp: false }

  @args.string({ description: 'The satellite package name (or manifest alias) to remove' })
  declare package: string

  async run() {
    const hostRoot = this.app.makePath()
    const satellites = await discoverSatellites(hostRoot, (m) => this.logger.warning(m))
    const sat = indexSatellites(satellites).get(this.package)

    if (!sat) {
      const installed = satellites.map((s) => s.packageName).join(', ') || '(none found)'
      this.logger.error(
        `No installed satellite matches "${this.package}". Installed satellites: ${installed}.`
      )
      this.exitCode = 1
      return
    }

    const { manifest } = sat
    const log = this.logger
    log.log('')
    log.log(`Removing the "${manifest.name}" satellite (${sat.packageName}). Manual steps:`)
    log.log('')

    // 1. adonisrc.ts entries (no automated removal exists).
    if (manifest.provider || manifest.commands) {
      log.log('1. Remove these line(s) from adonisrc.ts:')
      if (manifest.provider) log.log(`     providers:  () => import('${manifest.provider}')`)
      if (manifest.commands) log.log(`     commands:   () => import('${manifest.commands}')`)
    } else {
      log.log('1. No provider/commands were registered in adonisrc.ts — nothing to remove there.')
    }

    // 2. Published migrations (matched by the satellite's stub basenames).
    const published = await this.#findPublishedMigrations(
      sat.packageName,
      sat.root,
      manifest.migrations
    )
    log.log('')
    if (published.length > 0) {
      log.log('2. These migrations were published by this satellite. Roll them back, then delete:')
      for (const f of published) log.log(`     database/migrations/${f}`)
      log.log("   (back up first — rolling back DROPs the satellite's backoffice tables.)")
    } else {
      log.log('2. No published migrations from this satellite were found in database/migrations.')
    }

    // 3. Config block (we never patched it in, so we can't patch it out).
    log.log('')
    if (manifest.configSnippet) {
      log.log("3. Remove this satellite's block from config/multitenancy.ts (if you pasted it).")
    } else {
      log.log('3. This satellite has no config block to remove.')
    }

    // 4. Uninstall the package.
    log.log('')
    log.log(`4. Uninstall the package:  npm uninstall ${sat.packageName}`)
    log.log('')
    log.log('Lasagna does not edit adonisrc.ts or drop tables automatically, by design.')
  }

  /** Host migrations whose name matches one of the satellite's stub basenames. */
  async #findPublishedMigrations(
    packageName: string,
    root: string,
    migrationsDir?: string
  ): Promise<string[]> {
    if (!migrationsDir) return []
    let stubBasenames: string[]
    try {
      const files = await readdir(join(root, migrationsDir))
      stubBasenames = files.filter((f) => f.endsWith('.stub')).map((f) => f.replace(/\.stub$/, ''))
    } catch {
      return []
    }
    if (stubBasenames.length === 0) return []

    const migrationsPath =
      typeof (this.app as any).migrationsPath === 'function'
        ? (this.app as any).migrationsPath()
        : this.app.makePath('database', 'migrations')

    let hostFiles: string[]
    try {
      hostFiles = (await readdir(migrationsPath, { recursive: true })).map(
        (e) => e.split(/[\\/]/).pop() ?? e
      )
    } catch {
      return []
    }

    // Match the plain legacy `<digits>_<stub>.ts` and THIS satellite's namespaced
    // `<digits>_<slug>__<stub>.ts`. We scope the prefix to this package's slug so
    // we never list (and tell the operator to roll back) a DIFFERENT satellite's
    // migration that happens to share a stub basename.
    const slug = migrationSlug(packageName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const matches: string[] = []
    for (const stub of stubBasenames) {
      const escaped = stub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`^\\d+_(?:${slug}__)?${escaped}\\.ts$`)
      for (const f of hostFiles) if (re.test(f)) matches.push(f)
    }
    return matches.sort()
  }
}
