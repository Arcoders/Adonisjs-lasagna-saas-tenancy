import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { DateTime } from 'luxon'
import FeatureFlagService from '../services/feature_flag_service.js'

/**
 * Set (create or update) a tenant feature flag from the CLI. Goes through
 * FeatureFlagService so the shared cache is invalidated. This command needs
 * Redis reachable, unlike the read-only `get`/`list`.
 */
export default class TenantFeatureFlagSet extends BaseCommand {
  static readonly commandName = 'tenant:feature-flag:set'
  static readonly description = 'Create or update a tenant feature flag'
  static readonly options: CommandOptions = { startApp: true }

  @args.string({ description: 'Tenant ID' })
  declare tenantId: string

  @args.string({ description: 'Flag name' })
  declare flag: string

  @args.string({ description: 'Enabled state: true|false (also accepts 1|0)' })
  declare enabled: string

  @flags.string({
    flagName: 'config',
    description: 'Optional JSON object stored alongside the flag (e.g. \'{"rollout":25}\')',
  })
  declare config?: string

  @flags.string({
    flagName: 'expires-at',
    description: 'Optional ISO 8601 instant after which the flag evaluates as disabled',
  })
  declare expiresAt?: string

  async run() {
    const enabled = parseBool(this.enabled)
    if (enabled === null) {
      this.logger.error(`enabled must be one of true|false|1|0 (got "${this.enabled}")`)
      this.exitCode = 1
      return
    }

    let config: Record<string, unknown> | undefined
    if (this.config !== undefined) {
      try {
        const parsed = JSON.parse(this.config)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not a JSON object')
        }
        config = parsed as Record<string, unknown>
      } catch (error) {
        this.logger.error(`--config must be a JSON object: ${(error as Error).message}`)
        this.exitCode = 1
        return
      }
    }

    let expiresAt: DateTime | null = null
    if (this.expiresAt !== undefined) {
      const dt = DateTime.fromISO(this.expiresAt)
      if (!dt.isValid) {
        this.logger.error(`--expires-at must be a valid ISO 8601 instant (got "${this.expiresAt}")`)
        this.exitCode = 1
        return
      }
      expiresAt = dt
    }

    try {
      const svc = await app.container.make(FeatureFlagService)
      const row = await svc.set(this.tenantId, this.flag, enabled, config, expiresAt)
      this.logger.success(
        `Flag "${row.flag}" set to ${row.enabled} for tenant ${row.tenantId}` +
          (row.expiresAt ? ` (expires ${row.expiresAt.toISO()})` : '')
      )
    } catch (error) {
      this.logger.error(`Failed to set flag: ${(error as Error).message}`)
      this.exitCode = 1
    }
  }
}

function parseBool(value: string): boolean | null {
  const v = value.trim().toLowerCase()
  if (v === 'true' || v === '1') return true
  if (v === 'false' || v === '0') return false
  return null
}
