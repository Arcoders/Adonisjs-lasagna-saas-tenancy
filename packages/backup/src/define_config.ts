import type { MultitenancyConfig } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * The backup config block. Derived from core's `MultitenancyConfig['backup']`
 * (the shape backup owns) so there is a single source of truth and no
 * duplicated definition.
 */
export type BackupConfig = NonNullable<MultitenancyConfig['backup']>

/**
 * The host's `config/multitenancy.ts` shape with the backup block present.
 * Mirrors the reporting satellite's `MultitenancyConfigWithReporting`.
 */
export type MultitenancyConfigWithBackup = MultitenancyConfig & { backup?: BackupConfig }

/**
 * Identity helper for IDE autocomplete + type-checking when authoring the
 * `backup` block of `config/multitenancy.ts`. No runtime effect.
 */
export function defineBackupConfig(config: BackupConfig): BackupConfig {
  return config
}
