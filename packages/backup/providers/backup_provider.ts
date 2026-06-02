import type { ApplicationService } from '@adonisjs/core/types'
import logger from '@adonisjs/core/services/logger'
import { DoctorService } from '@adonisjs-lasagna/saas-tenancy/services'
import backupRecencyCheck from '../src/doctor/backup_recency_check.js'
import BackupTenant from '../src/jobs/backup_tenant.js'
import RestoreTenant from '../src/jobs/restore_tenant.js'
import CloneTenant from '../src/jobs/clone_tenant.js'

/**
 * Provider for `@adonisjs-lasagna/backup`. Register it in `adonisrc.ts`
 * alongside the core `MultitenancyProvider`. It does what the core used to do
 * for backup, inverted so the core never imports this package:
 *
 *  - `boot()`   — register the `backup_recency` check into the core
 *                 `DoctorService`, so `tenant:doctor` only runs it when this
 *                 package is installed.
 *  - `start()`  — register the backup jobs with the @adonisjs/queue Locator.
 */
export default class BackupProvider {
  constructor(protected app: ApplicationService) {}

  async boot() {
    const doctor = await this.app.container.make(DoctorService)
    if (!doctor.has('backup_recency')) doctor.register(backupRecencyCheck)
  }

  async start() {
    await this.#registerBackupJobs()
  }

  // Register the backup jobs with @adonisjs/queue's Locator. The core provider
  // auto-registers only the core jobs (its `jobs/index` no longer re-exports the
  // backup jobs), so without this a dispatched BackupTenant / RestoreTenant /
  // CloneTenant would dead-letter at the worker. Best-effort — a host without
  // @adonisjs/queue just skips it.
  async #registerBackupJobs(): Promise<void> {
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
}
