import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { resolveTenantRepository } from '../services/resolve_tenant_repository.js'
import { healTenant } from '../services/tenant_healer.js'
import { resolveMigrationConcurrency } from '../services/isolation/operational_budget.js'
import { mapWithConcurrency } from '../utils/concurrency.js'
import type { TenantModelContract } from '../types/contracts.js'

/**
 * Non-destructively brings a tenant (or the whole fleet) to a healthy,
 * fully-migrated, seeded state. Unlike `tenant:reprovision` (which refuses an
 * ACTIVE tenant and only re-runs provisioning), `tenant:heal` works on active
 * tenants and additionally MIGRATES to head and runs the `after:migrate` seeders —
 * so it cures the "active but never migrated" and "behind head" states the doctor
 * now detects.
 *
 * It composes {@link healTenant}, so it is provision-up-only: it never
 * drops/resets/rolls back, it is idempotent (a healthy tenant heals to a no-op), a
 * failure quarantines the tenant to `failed` (no data touched), and every heal is
 * audited (`tenant:heal`). A fleet heal is bounded by the operational connection
 * budget so it can never exhaust PostgreSQL.
 */
export default class HealTenant extends BaseCommand {
  static readonly commandName = 'tenant:heal'
  static readonly description =
    'Non-destructively bring tenant(s) to a healthy, fully-migrated, seeded state (provision-up-only)'
  static readonly options: CommandOptions = { startApp: true }

  @flags.array({
    alias: 't',
    flagName: 'tenant',
    required: false,
    description: 'Tenant ID(s) to heal. If omitted, heals every non-deleted tenant.',
  })
  declare tenantsIds?: string[]

  @flags.string({ description: 'Acting admin id recorded in the audit log (default: system)' })
  declare admin?: string

  @flags.boolean({
    default: false,
    flagName: 'dry-run',
    description: 'List the tenants that would be healed without applying any change',
  })
  declare dryRun: boolean

  @flags.boolean({
    description: 'Skip the confirmation prompt when healing the whole fleet',
    alias: 'y',
    default: false,
  })
  declare force: boolean

  @flags.number({
    flagName: 'concurrency',
    required: false,
    description:
      'Heal up to N tenants in parallel (default 1 = sequential). Clamped to the ' +
      'operational connection budget so it can never breach the absolute connection ceiling.',
  })
  declare concurrency?: number

  async run() {
    const repo = await resolveTenantRepository()
    const targeted = !!(this.tenantsIds && this.tenantsIds.length > 0)
    const fetched = targeted
      ? await repo.whereIn(this.tenantsIds!, true)
      : await repo.all({ includeDeleted: false })

    // A soft-deleted tenant's storage is correctly gone; healTenant refuses it too,
    // so drop them here rather than prompt/iterate over them.
    const targets = fetched.filter((t) => !t.isDeleted)

    if (targets.length === 0) {
      this.logger.info('No tenants to heal.')
      return
    }

    if (this.dryRun) {
      this.logger.info(
        `Dry run — ${targets.length} tenant(s) would be healed ` +
          `(provision-if-missing + migrate-to-head + seed):`
      )
      for (const t of targets) this.logger.info(`  ${t.id}  ${t.name}  (${t.status})`)
      this.logger.info(
        'No changes applied. Inspect pending migrations with: node ace tenant:doctor --check=migration_drift'
      )
      return
    }

    if (!targeted && !this.force) {
      const ok = await this.prompt.confirm(`Heal all ${targets.length} non-deleted tenant(s)?`)
      if (!ok) {
        this.logger.info('Aborted.')
        return
      }
    }

    const concurrency = resolveMigrationConcurrency(this.concurrency)
    let healed = 0
    let failed = 0

    const healOne = async (tenant: TenantModelContract) => {
      try {
        const result = await healTenant(tenant, {
          fireHooks: true,
          ...(this.admin !== undefined ? { admin: this.admin } : {}),
        })
        healed++
        this.logger.success(
          `healed "${tenant.name}" (${tenant.schemaName}) — provisioned=${result.provisioned} ` +
            `migrated=${result.migrated}${result.already ? ' (already healthy)' : ''}`
        )
      } catch (error: any) {
        failed++
        this.logger.error(
          `failed "${tenant.name}" (${tenant.schemaName}): ${error?.message ?? error}`
        )
      }
    }

    if (concurrency <= 1) {
      for (const tenant of targets) await healOne(tenant)
    } else {
      await mapWithConcurrency(targets, concurrency, healOne)
    }

    this.logger.info(`Done: ${healed} healed, ${failed} failed`)
    if (failed > 0) this.exitCode = 1
  }
}
