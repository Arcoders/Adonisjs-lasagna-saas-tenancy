import type { ApplicationService } from '@adonisjs/core/types'
import logger from '@adonisjs/core/services/logger'
import { definePlugin, LASAGNA_PLUGIN_API_VERSION } from '@adonisjs-lasagna/saas-tenancy/plugin'
import { DoctorService } from '@adonisjs-lasagna/saas-tenancy/services'
import backupRecencyCheck from '../src/doctor/backup_recency_check.js'
import backupEncryptionCheck from '../src/doctor/backup_encryption_check.js'
import BackupTenant from '../src/jobs/backup_tenant.js'
import RestoreTenant from '../src/jobs/restore_tenant.js'
import CloneTenant from '../src/jobs/clone_tenant.js'

/**
 * Provider for `@adonisjs-lasagna/backup`, built with the {@link definePlugin}
 * facade. Register it in `adonisrc.ts` alongside the core `MultitenancyProvider`.
 * It does what the core used to do for backup, inverted so the core never imports
 * this package. The facade wires the ABI backstops (Satellite ABI + plugin-API
 * contract) inside its own `boot()`, so this file declares only the two hooks:
 *
 *  - `boot`: register the `backup_recency` / `backup_encryption` checks into the
 *    core `DoctorService`, so `tenant:doctor` only runs them when this package is
 *    installed, then fail-fast if S3 is configured without its optional peer.
 *  - `start`: register the backup jobs with the @adonisjs/queue Locator.
 */
export default definePlugin({
  name: 'backup',
  packageName: '@adonisjs-lasagna/backup',
  // Mirrors package.json#lasagnaSatellite.satelliteApi.
  satelliteApi: 1,
  pluginApiVersion: LASAGNA_PLUGIN_API_VERSION,

  async boot(app) {
    const doctor = await app.container.make(DoctorService)
    if (!doctor.has('backup_recency')) doctor.register(backupRecencyCheck)
    if (!doctor.has('backup_encryption')) doctor.register(backupEncryptionCheck)
    await assertS3PeerIfEnabled(app)
  },

  async start() {
    await registerBackupJobs()
  },
})

/**
 * Fail fast at boot when S3 storage is CONFIGURED but its optional peer is
 * missing, instead of letting the first upload throw mid-backup in production.
 * The check is conditional on `backup.s3.enabled`, so an app that uses local
 * storage never pays for it and never needs `@aws-sdk/client-s3`.
 */
async function assertS3PeerIfEnabled(app: ApplicationService): Promise<void> {
  const cfg = app.config.get<{ backup?: { s3?: { enabled?: boolean } } }>('multitenancy')
  if (!cfg?.backup?.s3?.enabled) return
  try {
    // This is a RUNTIME presence probe, not a type dependency: import through a
    // specifier TypeScript must not resolve at build time, so `@aws-sdk/client-s3`
    // stays a genuine optional peer whether or not it is installed in this repo
    // (mirrors the websockets socket.io bootstrapper). A `@ts-ignore` would silence
    // a real future error; `@ts-expect-error` breaks the moment the peer IS present
    // in the build env. The un-analyzable import needs no suppression at all.
    await lazyImport('@aws-sdk/client-s3')
  } catch {
    throw new Error(
      '[backup] config.multitenancy.backup.s3.enabled is true but the optional peer ' +
        '`@aws-sdk/client-s3` is not installed. Install it with `npm i @aws-sdk/client-s3`, ' +
        'or set backup.s3.enabled to false. Failing at boot so an upload does not fail ' +
        'partway through a backup in production.'
    )
  }
}

/**
 * Import a module by a specifier TypeScript must NOT resolve at build time, so an
 * optional peer stays optional regardless of whether it is installed (mirrors core's
 * transmit bootstrapper and the websockets provider).
 */
function lazyImport(specifier: string): Promise<unknown> {
  return (Function('s', 'return import(s)') as (s: string) => Promise<unknown>)(specifier)
}

/**
 * Register the backup jobs with @adonisjs/queue's Locator. The core provider
 * auto-registers only the core jobs (its `jobs/index` no longer re-exports the
 * backup jobs), so without this a dispatched BackupTenant / RestoreTenant /
 * CloneTenant would dead-letter at the worker. Best-effort: a host without
 * @adonisjs/queue just skips it.
 */
async function registerBackupJobs(): Promise<void> {
  try {
    const { Locator } = await import('@adonisjs/queue')
    for (const JobClass of [BackupTenant, RestoreTenant, CloneTenant]) {
      const J = JobClass as unknown as { name: string; options?: { name?: string } }
      Locator.register(J.options?.name ?? J.name, JobClass as never)
    }
  } catch (error) {
    logger.warn(
      { err: (error as Error)?.message },
      '[backup] could not auto-register backup jobs with the @adonisjs/queue Locator'
    )
  }
}
