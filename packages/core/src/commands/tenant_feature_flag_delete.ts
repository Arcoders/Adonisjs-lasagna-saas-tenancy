import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import FeatureFlagService from '../services/feature_flag_service.js'

/**
 * Delete a tenant feature flag. Goes through FeatureFlagService so the shared
 * cache is invalidated. This command needs Redis reachable. Prompts for
 * confirmation unless --force.
 */
export default class TenantFeatureFlagDelete extends BaseCommand {
  static readonly commandName = 'tenant:feature-flag:delete'
  static readonly description = 'Delete a tenant feature flag'
  static readonly options: CommandOptions = { startApp: true }

  @args.string({ description: 'Tenant ID' })
  declare tenantId: string

  @args.string({ description: 'Flag name' })
  declare flag: string

  @flags.boolean({
    flagName: 'force',
    default: false,
    description: 'Skip the confirmation prompt',
  })
  declare force: boolean

  async run() {
    if (!this.force) {
      const confirmed = await this.prompt.confirm(
        `Delete flag "${this.flag}" for tenant ${this.tenantId}?`
      )
      if (!confirmed) {
        this.logger.info('Aborted.')
        return
      }
    }

    try {
      const svc = await app.container.make(FeatureFlagService)
      await svc.delete(this.tenantId, this.flag)
      this.logger.success(`Flag "${this.flag}" deleted for tenant ${this.tenantId}.`)
    } catch (error) {
      this.logger.error(`Failed to delete flag: ${(error as Error).message}`)
      this.exitCode = 1
    }
  }
}
