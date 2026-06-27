import type {
  MultitenancyConfig,
  BackupRetentionConfig,
} from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * The backup config block. Owned by the backup satellite (not core) so core's
 * frozen public type stays free of satellite-specific shapes. `retention` reuses
 * the generic `BackupRetentionConfig` that remains in core (it is shared with the
 * plan-tier backup cadence settings).
 */
export interface BackupConfig {
  storagePath: string
  metadataTtl: number
  pgConnection: {
    host: string
    port: number
    user: string
    password: string
    database: string
  }
  s3?: {
    enabled: boolean
    bucket: string
    region: string
    endpoint?: string
    accessKeyId: string
    secretAccessKey: string
  }
  retention?: BackupRetentionConfig
  /**
   * When the Redis coordination layer is unreachable, the destructive
   * operations (restore / clone / import) fail closed by default: they refuse
   * to run unserialised rather than risk corrupting a schema. Set this `true`
   * to opt them back into the legacy fail-open behaviour (proceed without the
   * lock). The read-only `backup` always fails open regardless of this flag.
   */
  lockFailOpenOnDestructive?: boolean
}

/**
 * Augment core's open `SatelliteConfigRegistry` so `getConfig().backup` (and any
 * `MultitenancyConfig` consumer) is typed wherever the backup satellite is
 * imported. The augmentation lives in this package's compilation only, so core —
 * which never imports backup — keeps a `backup`-free public type. This replaces
 * the old hard-coded `backup?` block on core's `MultitenancyConfig`.
 */
declare module '@adonisjs-lasagna/saas-tenancy/types' {
  interface SatelliteConfigRegistry {
    /** Optional backup satellite. See {@link BackupConfig}. */
    backup?: BackupConfig
  }
}

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
