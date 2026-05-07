import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { getConfig } from '../config.js'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract, TenantModelContract } from '../types/contracts.js'
import HookRegistry from '../services/hook_registry.js'
import { getActiveDriver } from '../services/isolation/active_driver.js'
import TenantMigrated from '../events/tenant_migrated.js'

/**
 * Drop and recreate the per-tenant storage, then re-run all migrations from
 * scratch. The DESTRUCTIVE counterpart to `tenant:migrate`. Equivalent to
 * Laravel's `tenants:migrate-fresh`.
 *
 * For `rowscope-pg` this falls back to a `delete-all` since storage is
 * shared (the driver's `reset()` issues `DELETE FROM ... WHERE tenant_id`
 * for every configured table); migrations then become a no-op.
 */
export default class TenantMigrateFresh extends BaseCommand {
  static readonly commandName = 'tenant:migrate:fresh'
  static readonly description =
    'Drop and recreate per-tenant storage, then re-run migrations. DESTRUCTIVE.'
  static readonly options: CommandOptions = { startApp: true }

  @flags.array({
    alias: 't',
    flagName: 'tenant',
    required: false,
    description: 'Tenant ID(s) to refresh. Omit to refresh every tenant',
  })
  declare tenantsIds?: string[]

  @flags.boolean({
    alias: 'y',
    default: false,
    flagName: 'force',
    description: 'Skip the confirmation prompt (required for non-interactive runs)',
  })
  declare force: boolean

  @flags.boolean({
    default: false,
    flagName: 'seed',
    description: 'Run seeders after migrations finish for each tenant',
  })
  declare seed: boolean

  @flags.boolean({ default: false, flagName: 'disable-locks', description: 'Disable migration locks' })
  declare disableLocks: boolean

  @flags.boolean({ default: false, flagName: 'verbose' })
  declare verbose: boolean

  async run() {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
    const tenants =
      this.tenantsIds && this.tenantsIds.length > 0
        ? await repo.whereIn(this.tenantsIds, true)
        : await repo.all({ includeDeleted: true })

    if (tenants.length === 0) {
      this.logger.info('No tenants found.')
      return
    }

    if (!this.force) {
      const confirmed = await this.prompt.confirm(
        `Refreshing ${tenants.length} tenant(s) will DROP and recreate their storage. ` +
          `All data outside the schema is lost. Continue?`
      )
      if (!confirmed) {
        this.logger.info('Aborted.')
        return
      }
    }

    const hooks = await app.container.make(HookRegistry)
    const driver = await getActiveDriver()
    let succeeded = 0
    let failed = 0

    for (const tenant of tenants) {
      const ok = await this.#refreshOne(tenant, driver, hooks)
      if (ok) succeeded++
      else failed++
    }

    this.logger.info(`Done: ${succeeded} succeeded, ${failed} failed`)
    if (failed > 0) this.exitCode = 1
  }

  async #refreshOne(
    tenant: TenantModelContract,
    driver: Awaited<ReturnType<typeof getActiveDriver>>,
    hooks: HookRegistry
  ): Promise<boolean> {
    const tasks = this.ui.tasks({ verbose: this.verbose })

    let ok = true
    await tasks
      .add(`Refreshing "${tenant.name}" (${tenant.schemaName})`, async (task) => {
        try {
          task.update('Resetting storage...')
          await driver.reset(tenant)

          await hooks.run('before', 'migrate', { tenant, direction: 'up' })
          task.update('Running migrations...')
          await driver.migrate(tenant, {
            direction: 'up',
            disableLocks: this.disableLocks,
          })
          await hooks.run('after', 'migrate', { tenant, direction: 'up' })
          await TenantMigrated.dispatch(tenant, 'up')

          if (this.seed) {
            task.update('Seeding...')
            const exit = await this.#runSeeder(tenant)
            if (exit !== 0) {
              throw new Error(`db:seed exited with code ${exit}`)
            }
          }

          return 'completed'
        } catch (error: any) {
          ok = false
          return this.verbose ? task.error(error.message) : task.error('failed')
        }
      })
      .run()

    return ok
  }

  async #runSeeder(tenant: TenantModelContract): Promise<number> {
    const connName = `${getConfig().tenantConnectionNamePrefix}${tenant.id}`
    const result = await this.kernel.exec('db:seed', ['--connection', connName])
    return result.exitCode ?? 0
  }
}
