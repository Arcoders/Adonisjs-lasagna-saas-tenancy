import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { getConfig } from '../config.js'
import { resolveTenantRepository } from '../services/resolve_tenant_repository.js'
import { tenancy } from '../tenancy.js'
import AuditLogService from '../services/audit_log_service.js'
import TenantAnonymized from '../events/tenant_anonymized.js'

/**
 * Run the host-provided anonymizer for a tenant (GDPR Art.17 erasure-by-
 * anonymization) and record the exercise in the immutable audit log. The PII
 * logic lives in `config.compliance.anonymize`. The package never touches your
 * models. Without that seam the command fails loudly: that means your
 * implementation is missing, not that the command is broken.
 */
export default class TenantGdprAnonymize extends BaseCommand {
  static readonly commandName = 'tenant:gdpr:anonymize'
  static readonly description =
    'Run the host-provided anonymizer for a tenant (GDPR Art.17) and record it in the audit log'
  static readonly options: CommandOptions = { startApp: true }

  @args.string({ description: 'Tenant ID to anonymize' })
  declare tenantId: string

  @flags.boolean({
    flagName: 'dry-run',
    default: false,
    description: 'Invoke the anonymizer in dry-run mode (no writes) and report the count',
  })
  declare dryRun: boolean

  @flags.boolean({ description: 'Skip the confirmation prompt', alias: 'y', default: false })
  declare force: boolean

  @flags.string({
    flagName: 'reason',
    description: 'Reason recorded in the audit log (e.g. a DSAR ticket id)',
  })
  declare reason?: string

  async run() {
    const anonymize = getConfig().compliance?.anonymize
    if (typeof anonymize !== 'function') {
      this.logger.error(
        'No anonymizer configured. Set config.compliance.anonymize in config/multitenancy.ts ' +
          '(see the "Implementing the GDPR anonymizer" section of the Compliance guide). ' +
          'This is the missing piece, not a bug — the package never touches your models.'
      )
      this.exitCode = 1
      return
    }

    const repo = await resolveTenantRepository()
    let tenant
    try {
      tenant = await repo.findByIdOrFail(this.tenantId)
    } catch (error: any) {
      this.logger.error(`Tenant not found: ${error.message}`)
      this.exitCode = 1
      return
    }

    if (!this.dryRun && !this.force) {
      const confirmed = await this.prompt.confirm(
        `Anonymize PII for tenant "${tenant.name}" (${tenant.email})? This cannot be undone.`
      )
      if (!confirmed) {
        this.logger.info('Aborted.')
        return
      }
    }

    // A dry run is a preview: run the anonymizer in dry mode and report the
    // count, but write NO audit row and dispatch NO event. Those signal a real
    // erasure. Emitting them on a preview would fire side-effecting listeners
    // and pollute the append-only (un-prunable) audit log on every preview.
    if (this.dryRun) {
      try {
        const result = await tenancy.run(tenant, () =>
          anonymize({
            tenant,
            ...(this.reason !== undefined ? { reason: this.reason } : {}),
            dryRun: true,
          })
        )
        const suffix = typeof result?.affected === 'number' ? ` (${result.affected} record(s))` : ''
        this.logger.info(
          `Dry run complete for "${tenant.name}"${suffix}. No data written, no audit entry recorded.`
        )
      } catch (error: any) {
        this.logger.error(`Dry run failed for "${tenant.name}": ${error.message}`)
        this.exitCode = 1
      }
      return
    }

    // Real run: anonymize, record immutable evidence, fan out the event.
    const audit = await app.container.make(AuditLogService)
    try {
      const result = await tenancy.run(tenant, () =>
        anonymize({
          tenant,
          ...(this.reason !== undefined ? { reason: this.reason } : {}),
          dryRun: false,
        })
      )
      const affected = result?.affected

      await this.#record(audit, tenant.id, {
        reason: this.reason ?? null,
        affected: affected ?? null,
        outcome: 'ok',
      })
      await TenantAnonymized.dispatch(tenant, {
        ...(this.reason !== undefined ? { reason: this.reason } : {}),
        ...(affected !== undefined ? { affected } : {}),
      })

      const suffix = typeof affected === 'number' ? ` (${affected} record(s))` : ''
      this.logger.success(`Anonymized PII for "${tenant.name}"${suffix}.`)
    } catch (error: any) {
      // The attempt itself is evidence worth keeping, so record the failure too.
      await this.#record(audit, tenant.id, {
        reason: this.reason ?? null,
        outcome: 'failed',
        error: error?.message ?? 'unknown',
      })
      this.logger.error(`Anonymization failed for "${tenant.name}": ${error.message}`)
      this.exitCode = 1
    }
  }

  /**
   * Best-effort audit write for a real (non-dry) run. The data operation may
   * already have happened irreversibly, so a missing/unreachable audit table
   * must not flip the command to a misleading failure. Warn loudly instead.
   */
  async #record(audit: AuditLogService, tenantId: string, metadata: Record<string, unknown>) {
    try {
      await audit.log({ tenantId, actorType: 'admin', action: 'gdpr.anonymize', metadata })
    } catch (error: any) {
      this.logger.warning(`Could not write the audit log entry: ${error?.message ?? 'unknown'}`)
    }
  }
}
