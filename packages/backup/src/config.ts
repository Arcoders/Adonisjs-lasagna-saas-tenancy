import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import type { MultitenancyConfig } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Resolve the `backup` config block, throwing a clear, actionable error when
 * the host hasn't configured it.
 *
 * `MultitenancyConfig.backup` is optional in the core (the backup feature lives
 * in this satellite, so a core-only consumer must not be forced to declare it).
 * Every backup code path goes through this accessor so a missing block surfaces
 * as one good error instead of an opaque "cannot read property of undefined".
 */
export function backupConfig(): NonNullable<MultitenancyConfig['backup']> {
  const cfg = getConfig().backup
  if (!cfg) {
    throw new Error(
      'multitenancy.backup is not configured. Add a `backup` block to ' +
        'config/multitenancy.ts (storagePath, pgConnection, and optionally s3 / ' +
        'retention) to use @adonisjs-lasagna/backup.'
    )
  }
  return cfg
}

/**
 * Whether the destructive backup operations (restore / clone / import) should
 * fail closed when the Redis operation lock is unavailable. Defaults to `true`
 * (refuse rather than run unserialised); a host opts back into the legacy
 * fail-open behaviour with `backup.lockFailOpenOnDestructive: true`.
 */
export function destructiveLockFailClosed(): boolean {
  return getConfig().backup?.lockFailOpenOnDestructive !== true
}
