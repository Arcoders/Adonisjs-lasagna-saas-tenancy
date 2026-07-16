import { BaseCommand, args } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import TenantFeatureFlag from '../models/satellites/tenant_feature_flag.js'

/**
 * Print a single tenant feature flag's stored state as JSON, or `null` when it
 * isn't set. Reads the database directly (the source of truth, no cache
 * staleness and no Redis dependency).
 */
export default class TenantFeatureFlagGet extends BaseCommand {
  static readonly commandName = 'tenant:feature-flag:get'
  static readonly description = 'Print one tenant feature flag as JSON (null when unset)'
  static readonly options: CommandOptions = { startApp: true }

  @args.string({ description: 'Tenant ID' })
  declare tenantId: string

  @args.string({ description: 'Flag name' })
  declare flag: string

  async run() {
    try {
      const row = await TenantFeatureFlag.query()
        .where('tenant_id', this.tenantId)
        .where('flag', this.flag)
        .first()

      const payload = row
        ? {
            flag: row.flag,
            enabled: row.enabled,
            config: row.config,
            expiresAt: row.expiresAt?.toISO() ?? null,
          }
        : null
      this.logger.log(JSON.stringify(payload, null, 2))
    } catch (error) {
      this.logger.error(`Failed to read flag: ${(error as Error).message}`)
      this.exitCode = 1
    }
  }
}
