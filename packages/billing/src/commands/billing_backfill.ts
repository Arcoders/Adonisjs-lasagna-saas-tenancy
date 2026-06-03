import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { TENANT_REPOSITORY } from '@adonisjs-lasagna/saas-tenancy/types'
import type { TenantRepositoryContract } from '@adonisjs-lasagna/saas-tenancy/types'
import { QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantPlan } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'

/**
 * Seed a `tenant_plans` row for every tenant that doesn't have one. Use
 * cases:
 *   - First-time install of `--with=billing` on an app with existing tenants.
 *   - Migration from a host-managed `tenants.plan_id` column → `tenant_plans`.
 *
 * Idempotent. Skip-by-default for tenants that already have a row, even
 * if their plan differs from `defaultPlan`. Pass `--force` to overwrite
 * (rare; usually you want sync from Stripe to win).
 */
export default class BillingBackfill extends BaseCommand {
  static readonly commandName = 'tenant:billing:backfill'
  static readonly description =
    "Seed tenant_plans rows with the default plan for every tenant that doesn't have one"
  static readonly options: CommandOptions = { startApp: true }

  @flags.boolean({ flagName: 'dry-run', default: false, description: 'Report without writing' })
  declare dryRun: boolean

  @flags.boolean({
    flagName: 'force',
    default: false,
    description: 'Overwrite existing rows instead of skipping them',
  })
  declare force: boolean

  @flags.string({
    flagName: 'plan',
    description: 'Plan name to assign. Defaults to config.billing.defaultPlan.',
  })
  declare plan?: string

  async run() {
    const cfg = getConfig().billing
    const planName = this.plan ?? cfg?.defaultPlan
    if (!planName) {
      this.logger.error('No default plan: set --plan or configure config.billing.defaultPlan')
      this.exitCode = 1
      return
    }
    const plansCfg = getConfig().plans
    if (plansCfg && !plansCfg.definitions[planName]) {
      this.logger.error(`Plan "${planName}" is not in config.plans.definitions`)
      this.exitCode = 1
      return
    }

    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract

    const quotas = await app.container.make(QuotaService)
    let scanned = 0
    let assigned = 0
    let skipped = 0

    await repo.each(async (tenant) => {
      scanned += 1
      const existing = await TenantPlan.find(tenant.id)
      if (existing && !this.force) {
        skipped += 1
        return
      }
      if (this.dryRun) {
        this.logger.warning(`would assign  ${tenant.id} → ${planName}`)
        return
      }
      await quotas.assignPlan(tenant.id, planName, { source: 'backfill' })
      assigned += 1
    })

    this.logger.log('')
    this.logger.log(
      `${this.colors.bold('summary')}  scanned=${scanned}  assigned=${assigned}  skipped=${skipped}`
    )
  }
}
