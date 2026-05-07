import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { getConfig } from '../config.js'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract } from '../types/contracts.js'
import HookRegistry from '../services/hook_registry.js'
import { getActiveDriver } from '../services/isolation/active_driver.js'
import TenantDeleted from '../events/tenant_deleted.js'
import { isExpired, DEFAULT_SOFT_DELETE_RETENTION_DAYS } from '../utils/soft_delete.js'

export default class TenantPurgeExpired extends BaseCommand {
  static readonly commandName = 'tenant:purge-expired'
  static readonly description =
    'Drop schemas of soft-deleted tenants whose retention window has elapsed. Idempotent — safe to run from cron.'
  static readonly options: CommandOptions = { startApp: true }

  @flags.number({
    flagName: 'retention-days',
    description:
      'Override config.softDelete.retentionDays for this run (e.g. --retention-days=7)',
  })
  declare retentionDays?: number

  @flags.boolean({
    flagName: 'dry-run',
    default: false,
    description: 'Report what would be purged without dropping anything',
  })
  declare dryRun: boolean

  @flags.boolean({
    flagName: 'force',
    alias: 'y',
    default: false,
    description: 'Skip the confirmation prompt',
  })
  declare force: boolean

  async run() {
    const cfg = getConfig().softDelete
    const retentionDays =
      this.retentionDays ?? cfg?.retentionDays ?? DEFAULT_SOFT_DELETE_RETENTION_DAYS

    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
    const all = await repo.all({ includeDeleted: true })

    const candidates = all.filter((t) => t.isDeleted && isExpired(t.deletedAt, retentionDays))

    if (candidates.length === 0) {
      this.logger.info(
        `No tenants past the ${retentionDays}-day retention window. Nothing to purge.`
      )
      return
    }

    this.logger.info(
      `Found ${candidates.length} tenant(s) past the ${retentionDays}-day window:`
    )
    for (const t of candidates) {
      this.logger.info(`  ${t.id} ${this.colors.dim(`(${t.name})`)} — deleted ${t.deletedAt?.toISO()}`)
    }

    if (this.dryRun) {
      this.logger.info('Dry run — no schemas dropped.')
      return
    }

    if (!this.force) {
      const confirmed = await this.prompt.confirm(
        `Drop the schema for each of the ${candidates.length} tenant(s) above? This cannot be undone.`
      )
      if (!confirmed) {
        this.logger.info('Aborted.')
        return
      }
    }

    const hooks = await app.container.make(HookRegistry)
    const driver = await getActiveDriver()
    let purged = 0
    let failed = 0

    for (const tenant of candidates) {
      try {
        await hooks.run('before', 'destroy', { tenant })
        await driver.destroy(tenant)
        await hooks.run('after', 'destroy', { tenant })
        await TenantDeleted.dispatch(tenant)
        this.logger.info(`  purged ${tenant.id}`)
        purged++
      } catch (error: any) {
        this.logger.error(`  ${tenant.id}: ${error.message}`)
        failed++
      }
    }

    this.logger.info(`Done: ${purged} purged, ${failed} failed`)
    if (failed > 0) this.exitCode = 1
  }
}
