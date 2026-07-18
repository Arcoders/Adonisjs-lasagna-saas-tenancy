import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { resolveTenantRepository } from '../services/resolve_tenant_repository.js'
import type { TenantModelContract } from '../types/contracts.js'
import HookRegistry from '../services/hook_registry.js'
import { getActiveDriver } from '../services/isolation/active_driver.js'
import { resolveMigrationConcurrency } from '../services/isolation/operational_budget.js'
import { mapWithConcurrency } from '../utils/concurrency.js'
import TenantMigrated from '../events/tenant_migrated.js'
import { migrationTaskError } from './migration_task_error.js'

export default class RunTenantMigrations extends BaseCommand {
  static readonly commandName = 'migration:tenant:run'
  static readonly description = 'Migrate the tenant schema'
  static readonly options: CommandOptions = { startApp: true }

  @flags.array({
    alias: 't',
    flagName: 'tenant',
    required: false,
    description: 'Tenant(s) id(s) to migrate. If not provided, all tenants will be migrated',
  })
  declare tenantsIds?: string[]

  @flags.boolean({ default: false, flagName: 'dry-run', description: 'View SQL without running' })
  declare dryRun: boolean

  @flags.boolean({
    default: false,
    flagName: 'disable-locks',
    description: 'Disable migration locks',
  })
  declare disableLocks: boolean

  @flags.number({
    flagName: 'concurrency',
    required: false,
    description:
      'Migrate up to N tenants in parallel (default 1 = sequential). Clamped to the ' +
      'operational connection budget so it can never exceed the absolute connection ceiling.',
  })
  declare concurrency?: number

  @flags.boolean({ default: false, flagName: 'verbose' })
  declare verbose: boolean

  async run() {
    const repo = await resolveTenantRepository()
    const tenants =
      this.tenantsIds && this.tenantsIds.length > 0
        ? await repo.whereIn(this.tenantsIds, true)
        : await repo.all({ includeDeleted: true })

    // F1 — a bounded, cap-aware migration worker pool. Concurrency is clamped to
    // the operational connection budget (S2), so a parallel run can never open more
    // connections than the budget allows or breach the absolute ceiling. Default 1
    // keeps the interactive, sequential UX unchanged; `--concurrency N` opts in.
    const concurrency = resolveMigrationConcurrency(this.concurrency)
    if (concurrency <= 1) {
      for (const tenant of tenants) {
        await this.migrateTenant(tenant)
      }
      return
    }

    await this.migrateBatch(tenants, concurrency)
  }

  /**
   * The per-tenant migration core, shared by the sequential (interactive) and the
   * parallel (batch) paths. Reports progress through `update` and THROWS on
   * failure; each caller decides how to render and isolate that.
   */
  private async migrateCore(
    tenant: TenantModelContract,
    update: (message: string) => void
  ): Promise<void> {
    const hooks = await app.container.make(HookRegistry)
    const driver = await getActiveDriver()

    update('Connecting to the tenant database')
    await driver.connect(tenant, { bypassSoftCap: true })

    if (!this.dryRun) {
      await hooks.run('before', 'migrate', { tenant, direction: 'up' })
    }

    update('Running migrations')
    await driver.migrate(tenant, {
      direction: 'up',
      disableLocks: this.disableLocks,
      dryRun: this.dryRun,
    })

    if (!this.dryRun) {
      await hooks.run('after', 'migrate', { tenant, direction: 'up' })
      await TenantMigrated.dispatch(tenant, 'up')
    }
  }

  private async migrateTenant(tenant: TenantModelContract) {
    const tasks = this.ui.tasks({ verbose: this.verbose })

    await tasks
      .add(`Migrating tenant "${tenant.name}": schema (${tenant.schemaName})`, async (task) => {
        try {
          await this.migrateCore(tenant, (message) => task.update(message))
          return 'completed'
        } catch (error) {
          return migrationTaskError(task, error)
        }
      })
      .run()
  }

  /**
   * Run the batch through the bounded pool. Per-tenant failure isolation: one
   * tenant's failure is captured, never aborts the batch, and the run's exit code
   * reflects any failure so a CI/deploy step still fails loudly. Results preserve
   * input order for a deterministic summary.
   */
  private async migrateBatch(tenants: TenantModelContract[], concurrency: number) {
    this.logger.info(`Migrating ${tenants.length} tenant(s) with concurrency ${concurrency}`)

    const outcomes = await mapWithConcurrency(tenants, concurrency, async (tenant) => {
      try {
        await this.migrateCore(tenant, (message) =>
          this.verbose ? this.logger.info(`[${tenant.name}] ${message}`) : undefined
        )
        this.logger.success(`migrated "${tenant.name}" (${tenant.schemaName})`)
        return { tenant, ok: true as const }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.logger.error(`failed "${tenant.name}" (${tenant.schemaName}): ${message}`)
        return { tenant, ok: false as const }
      }
    })

    const failed = outcomes.filter((o) => !o.ok)
    this.logger.info(`Migrated ${outcomes.length - failed.length}/${outcomes.length} tenant(s)`)
    if (failed.length > 0) {
      this.exitCode = 1
      this.logger.error(`${failed.length} tenant(s) failed to migrate`)
    }
  }
}
