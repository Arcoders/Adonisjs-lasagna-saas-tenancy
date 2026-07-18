import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { resolveTenantRepository } from '../services/resolve_tenant_repository.js'
import HookRegistry from '../services/hook_registry.js'
import { getActiveDriver } from '../services/isolation/active_driver.js'
import { discoverSatellites, satelliteMigrationDirs } from '../sdk/configure_kit.js'
import TenantMigrated from '../events/tenant_migrated.js'
import { migrationTaskError } from './migration_task_error.js'

export default class TenantMigrateRollback extends BaseCommand {
  static readonly commandName = 'tenant:migrate:rollback'
  static readonly description = 'Rollback last migration for one or all tenant schemas'
  static readonly options: CommandOptions = { startApp: true }

  @flags.array({
    alias: 't',
    flagName: 'tenant',
    required: false,
    description: 'Tenant ID(s) to rollback. Omit for all tenants',
  })
  declare tenantsIds?: string[]

  @flags.boolean({
    default: false,
    flagName: 'dry-run',
    description: 'Print SQL without executing',
  })
  declare dryRun: boolean

  @flags.boolean({ default: false, flagName: 'disable-locks' })
  declare disableLocks: boolean

  @flags.boolean({ default: false, flagName: 'verbose' })
  declare verbose: boolean

  async run() {
    const repo = await resolveTenantRepository()
    const tenants =
      this.tenantsIds && this.tenantsIds.length > 0
        ? await repo.whereIn(this.tenantsIds)
        : await repo.all()

    if (tenants.length === 0) {
      this.logger.info('No tenants found.')
      return
    }

    const hooks = await app.container.make(HookRegistry)
    const driver = await getActiveDriver()
    // Fold in the satellite per-tenant migration dirs exactly as `tenant:migrate`
    // does. Otherwise a rollback cannot find a satellite migration's `down()`
    // (e.g. the AI `ai_embeddings` migration recorded in the ledger) and chokes on
    // a "migration source is missing" for the whole batch.
    const extraMigrationPaths = await this.#satellitePerTenantMigrationDirs()
    let succeeded = 0
    let failed = 0

    for (const tenant of tenants) {
      const tasks = this.ui.tasks({ verbose: this.verbose })

      await tasks
        .add(`Rolling back "${tenant.name}" (${tenant.schemaName})`, async (task) => {
          try {
            task.update('Connecting...')
            await driver.connect(tenant, { bypassSoftCap: true })

            if (!this.dryRun) {
              await hooks.run('before', 'migrate', { tenant, direction: 'down' })
            }

            task.update('Rolling back last migration...')
            await driver.migrate(tenant, {
              direction: 'down',
              disableLocks: this.disableLocks,
              dryRun: this.dryRun,
              extraMigrationPaths,
            })

            if (!this.dryRun) {
              await hooks.run('after', 'migrate', { tenant, direction: 'down' })
              await TenantMigrated.dispatch(tenant, 'down')
            }

            succeeded++
            return 'completed'
          } catch (error: any) {
            failed++
            return migrationTaskError(task, error)
          }
        })
        .run()
    }

    this.logger.info(`Done: ${succeeded} succeeded, ${failed} failed`)
  }

  /**
   * Per-tenant migration directories contributed by installed satellites,
   * mirroring `tenant:migrate` so a rollback folds the SAME dirs and can find every
   * satellite migration's `down()`. Manifests are read as JSON (no satellite code
   * imported); the dirs are identical for all tenants, so this resolves once.
   */
  async #satellitePerTenantMigrationDirs(): Promise<string[]> {
    const hostRoot = this.app.makePath()
    const satellites = await discoverSatellites(hostRoot, (m) => this.logger.warning(m))
    const dirs = satelliteMigrationDirs(hostRoot, satellites)
    if (dirs.length > 0) {
      this.logger.info(`Folding ${dirs.length} satellite per-tenant migration dir(s) into the run.`)
    }
    return dirs
  }
}
