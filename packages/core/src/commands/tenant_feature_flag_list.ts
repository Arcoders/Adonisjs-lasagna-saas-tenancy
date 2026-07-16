import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import TenantFeatureFlag from '../models/satellites/tenant_feature_flag.js'

/**
 * List every feature flag for a tenant. Reads the database directly (source of
 * truth, no cache/Redis dependency). Renders a table by default, or a JSON
 * array with --json.
 */
export default class TenantFeatureFlagList extends BaseCommand {
  static readonly commandName = 'tenant:feature-flag:list'
  static readonly description = 'List all feature flags for a tenant'
  static readonly options: CommandOptions = { startApp: true }

  @args.string({ description: 'Tenant ID' })
  declare tenantId: string

  @flags.boolean({
    flagName: 'json',
    default: false,
    description: 'Emit a JSON array instead of a table',
  })
  declare json: boolean

  async run() {
    try {
      const rows = await TenantFeatureFlag.query().where('tenant_id', this.tenantId).orderBy('flag')

      const records = rows.map((r) => ({
        flag: r.flag,
        enabled: r.enabled,
        config: r.config,
        expiresAt: r.expiresAt?.toISO() ?? null,
      }))

      if (this.json) {
        this.logger.log(JSON.stringify(records, null, 2))
        return
      }

      if (records.length === 0) {
        this.logger.info(`No feature flags set for tenant ${this.tenantId}.`)
        return
      }

      const table = this.ui.table()
      table.head(['Flag', 'Enabled', 'Expires at', 'Config'])
      for (const r of records) {
        table.row([
          r.flag,
          String(r.enabled),
          r.expiresAt ?? '—',
          r.config ? JSON.stringify(r.config) : '—',
        ])
      }
      table.render()
    } catch (error) {
      this.logger.error(`Failed to list flags: ${(error as Error).message}`)
      this.exitCode = 1
    }
  }
}
