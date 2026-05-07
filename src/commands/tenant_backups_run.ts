import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract, TenantModelContract } from '../types/contracts.js'
import BackupService from '../services/backup_service.js'
import BackupRetentionService from '../services/backup_retention_service.js'

export default class TenantBackupsRun extends BaseCommand {
  static readonly commandName = 'tenant:backups:run'
  static readonly description =
    'Run scheduled backups for tenants whose tier interval has elapsed, then apply retention. Idempotent — safe to run from cron.'
  static readonly options: CommandOptions = { startApp: true }

  @flags.array({
    alias: 't',
    flagName: 'tenant',
    description: 'Limit the run to one or more tenant IDs',
  })
  declare tenant?: string[]

  @flags.boolean({
    flagName: 'force',
    default: false,
    description: 'Ignore tier intervalHours; back up every selected tenant',
  })
  declare force: boolean

  @flags.boolean({
    flagName: 'dry-run',
    default: false,
    description: 'Report what would happen without backing up or deleting anything',
  })
  declare dryRun: boolean

  @flags.boolean({
    flagName: 'no-retention',
    default: false,
    description: 'Skip the retention sweep (keep all archives untouched)',
  })
  declare noRetention: boolean

  async run() {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
    const backups = new BackupService()
    const retention = new BackupRetentionService(backups)

    const allActive = await repo.all({ statuses: ['active'] })
    const tenants = this.tenant?.length
      ? allActive.filter((t) => this.tenant!.includes(t.id))
      : allActive

    if (tenants.length === 0) {
      this.logger.info('No active tenants found.')
      return
    }

    let backedUp = 0
    let skipped = 0
    let failed = 0
    let purged = 0

    for (const tenant of tenants) {
      const due = this.force || (await retention.shouldBackup(tenant))

      if (!due) {
        skipped++
        if (this.dryRun) this.logger.info(`skip ${tenant.id} ${this.colors.dim('(not yet due)')}`)
        continue
      }

      const action = this.dryRun ? 'would back up' : 'backing up'
      this.logger.info(`${action} ${tenant.id} (${tenant.name})`)

      if (!this.dryRun) {
        try {
          await backups.backup(tenant)
          backedUp++
        } catch (error: any) {
          failed++
          this.logger.error(`Backup failed for ${tenant.id}: ${error.message}`)
          continue
        }
      } else {
        backedUp++
      }

      if (!this.noRetention) {
        purged += await this.#sweepRetention(tenant, retention)
      }
    }

    const verb = this.dryRun ? 'Would have' : 'Done:'
    this.logger.info(
      `${verb} backed up ${backedUp}, skipped ${skipped}, failed ${failed}, purged ${purged} archive(s)`
    )

    if (failed > 0) this.exitCode = 1
  }

  async #sweepRetention(
    tenant: TenantModelContract,
    retention: BackupRetentionService
  ): Promise<number> {
    try {
      if (this.dryRun) {
        const plan = await retention.planRetention(tenant)
        if (plan.purged.length > 0) {
          this.logger.info(
            `  retention: would purge ${plan.purged.length}, keep ${plan.kept.length}`
          )
        }
        return plan.purged.length
      }
      const plan = await retention.applyRetention(tenant)
      if (plan.purged.length > 0) {
        this.logger.info(`  retention: purged ${plan.purged.length}, keep ${plan.kept.length}`)
      }
      return plan.purged.length
    } catch (error: any) {
      this.logger.warning(`Retention sweep failed for ${tenant.id}: ${error.message}`)
      return 0
    }
  }
}
