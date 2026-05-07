import { getConfig } from '../config.js'
import type { TenantModelContract } from '../types/contracts.js'
import type {
  BackupRetentionConfig,
  BackupRetentionTier,
} from '../types/config.js'
import type { BackupMetadata } from './backup_service.js'
import BackupService from './backup_service.js'

const DEFAULT_RETENTION: BackupRetentionConfig = {
  defaultTier: 'standard',
  tiers: {
    standard: { intervalHours: 24, keepLast: 7 },
  },
}

export interface RetentionPlan {
  /** Files preserved on disk/S3 after retention is applied. */
  kept: BackupMetadata[]
  /** Files that would be / were purged. */
  purged: BackupMetadata[]
}

export default class BackupRetentionService {
  readonly #backups: BackupService

  constructor(backups: BackupService = new BackupService()) {
    this.#backups = backups
  }

  /**
   * Resolve the retention tier for a tenant. Honors `config.backup.retention.getTier`
   * when defined, otherwise falls back to `defaultTier`.
   *
   * Throws if the resolved tier name is not declared in `tiers`.
   */
  async getTierFor(tenant: TenantModelContract): Promise<BackupRetentionTier> {
    const cfg = getConfig().backup.retention ?? DEFAULT_RETENTION
    const resolved = (await cfg.getTier?.(tenant)) ?? cfg.defaultTier
    const tier = cfg.tiers[resolved]
    if (!tier) {
      throw new Error(
        `BackupRetentionService: tier "${resolved}" is not declared in config.backup.retention.tiers`
      )
    }
    return tier
  }

  /**
   * Decide whether the tenant is due for a fresh backup based on its tier
   * `intervalHours` and the latest backup timestamp.
   */
  async shouldBackup(
    tenant: TenantModelContract,
    now: number = Date.now()
  ): Promise<boolean> {
    const tier = await this.getTierFor(tenant)
    const list = await this.#backups.listBackups(tenant.id)
    if (list.length === 0) return true

    const timestamps = list
      .map((b) => Date.parse(b.timestamp))
      .filter((t) => Number.isFinite(t)) as number[]
    if (timestamps.length === 0) return true

    const latest = Math.max(...timestamps)
    const ageMs = now - latest
    return ageMs >= tier.intervalHours * 3600_000
  }

  /**
   * Compute which backups should be kept vs purged, sorted by recency
   * (newest first). Pure: does not perform deletion.
   */
  async planRetention(tenant: TenantModelContract): Promise<RetentionPlan> {
    const tier = await this.getTierFor(tenant)
    const list = await this.#backups.listBackups(tenant.id)

    const sorted = [...list].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    const kept = sorted.slice(0, tier.keepLast)
    const purged = sorted.slice(tier.keepLast)
    return { kept, purged }
  }

  /**
   * Apply retention by deleting any backup beyond `keepLast`. Returns the
   * plan that was executed. Errors during deletion of a single archive are
   * swallowed so retention is best-effort across the whole list.
   */
  async applyRetention(tenant: TenantModelContract): Promise<RetentionPlan> {
    const plan = await this.planRetention(tenant)
    for (const meta of plan.purged) {
      try {
        await this.#backups.deleteBackup(tenant.id, meta.file)
      } catch {
        // best-effort; the next run will retry
      }
    }
    return plan
  }
}
