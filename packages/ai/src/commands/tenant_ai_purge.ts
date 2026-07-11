import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { userInfo } from 'node:os'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { resolveTenantRepository } from '@adonisjs-lasagna/saas-tenancy/services'
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'
import { hashAuditPrincipal } from '../gateway/audit_seam.js'
import AiComplianceService, { type PurgeSummary } from '../services/ai_compliance_service.js'
import VectorStoreService from '../services/vector_store_service.js'

/**
 * Operator-privileged erasure of a tenant's AI data: conversation
 * memory + the response-cache epoch + embeddings. Composes the existing purge
 * seams through `AiComplianceService`, records the admin action in the audit log
 * (best-effort), and reports an HONEST per-step summary. Scopes:
 *
 *   tenant:ai:purge --tenant <uuid> --force              # everything for a tenant
 *   tenant:ai:purge --tenant <uuid> --principal <id>     # one user (GDPR Art.17)
 *   tenant:ai:purge --tenant <uuid> --source <key>       # one document
 *
 * `--dry-run` previews the counts and writes nothing (no delete, no epoch bump).
 * A full-tenant purge requires `--force`; per-user and per-source erasures do not
 * (they are the routine DSAR path). The immutable AI audit chain is non-PII and
 * intentionally survives.
 */
export default class TenantAiPurge extends BaseCommand {
  static readonly commandName = 'tenant:ai:purge'
  static readonly description =
    'Erase a tenant, principal, or document AI data (memory + response cache + embeddings) for GDPR'
  static readonly options: CommandOptions = { startApp: true }

  @flags.string({ flagName: 'tenant', description: 'Tenant id (uuid) to purge (required)' })
  declare tenant?: string

  @flags.string({
    flagName: 'principal',
    description: 'Purge only this principal (per-user GDPR erasure: memory + their embeddings)',
  })
  declare principal?: string

  @flags.string({ flagName: 'source', description: 'Purge only this document source key' })
  declare source?: string

  @flags.boolean({
    flagName: 'dry-run',
    default: false,
    description: 'Preview the counts and write nothing (no delete, no epoch bump)',
  })
  declare dryRun: boolean

  @flags.boolean({
    flagName: 'force',
    alias: 'y',
    default: false,
    description: 'Required for a full-tenant purge (skips the confirmation)',
  })
  declare force: boolean

  @flags.boolean({
    flagName: 'verify-chain',
    default: false,
    description: 'Also re-walk the full AI audit chain and record the result (O(n))',
  })
  declare verifyChain: boolean

  @flags.string({
    flagName: 'actor',
    description: 'Operator identity recorded in the audit row (defaults to the OS user)',
  })
  declare actor?: string

  async run() {
    const ai = getConfig().ai
    if (!ai) {
      this.logger.error('config.ai is not configured; there is no AI data to purge.')
      this.exitCode = 1
      return
    }
    if (!this.tenant) {
      this.logger.error('--tenant <uuid> is required.')
      this.exitCode = 1
      return
    }
    if (this.principal && this.source) {
      this.logger.error('Pass at most one of --principal or --source.')
      this.exitCode = 1
      return
    }

    const repo = await resolveTenantRepository()
    let tenant
    try {
      tenant = await repo.findByIdOrFail(this.tenant)
    } catch (error: any) {
      this.logger.error(`Tenant not found: ${error.message}`)
      this.exitCode = 1
      return
    }

    const scope: 'tenant' | 'user' | 'source' = this.principal
      ? 'user'
      : this.source
        ? 'source'
        : 'tenant'

    if (this.dryRun) {
      await this.#preview(tenant, scope, ai.embedding !== undefined)
      return
    }

    // A full-tenant erasure is the destructive one; per-user / per-source are the
    // routine DSAR path and do not require --force.
    if (scope === 'tenant' && !this.force) {
      const ok = await this.prompt.confirm(
        `Purge ALL AI data (memory + cache + embeddings) for tenant ${tenant.id}? This cannot be undone.`
      )
      if (!ok) {
        this.logger.info('Aborted.')
        return
      }
    }

    const compliance = await this.app.container.make(AiComplianceService)
    const opts = {
      actorId: this.actor ?? safeOsUser(),
      verifyChain: this.verifyChain,
    }
    let summary: PurgeSummary
    if (scope === 'user') {
      summary = await compliance.purgeUser(tenant, this.principal!, opts)
    } else if (scope === 'source') {
      summary = await compliance.purgeSource(tenant, this.source!, opts)
    } else {
      summary = await compliance.purgeTenant(tenant, opts)
    }

    this.#report(summary)
    this.exitCode = summary.ok ? 0 : 1
  }

  /** Read-only preview: report the embedding count that would be erased, writing nothing. */
  async #preview(
    tenant: { id: string },
    scope: 'tenant' | 'user' | 'source',
    embeddingsEnabled: boolean
  ): Promise<void> {
    let embeddings = 0
    if (embeddingsEnabled) {
      const store = await this.app.container.make(VectorStoreService)
      embeddings = await tenancy.run(tenant as never, async () => {
        if (scope === 'user')
          return store.countByActor(tenant as never, hashAuditPrincipal(this.principal!)!)
        if (scope === 'source') return store.countBySource(tenant as never, this.source!)
        return store.count(tenant as never)
      })
    }
    this.logger.info(
      `[dry-run] scope=${scope} tenant=${tenant.id}: would delete ${embeddings} embedding(s); ` +
        `conversation memory and the response cache would also be cleared. No changes were made.`
    )
  }

  /** Print the honest per-step summary; a `failed` step means a non-zero exit and a retry. */
  #report(summary: PurgeSummary): void {
    for (const step of summary.steps) {
      const count = step.count !== undefined ? ` (${step.count})` : ''
      const code = step.code ? ` [${step.code}]` : ''
      const line = `  ${step.step}: ${step.status}${count}${code}`
      if (step.status === 'failed') this.logger.log(this.colors.red(line))
      else if (step.status === 'skipped') this.logger.log(this.colors.dim(line))
      else this.logger.log(this.colors.green(line))
    }
    const head = `${summary.scope} purge for ${summary.tenantId}: ${summary.ok ? 'OK' : 'INCOMPLETE (retry)'}`
    this.logger.log(summary.ok ? this.colors.green(head) : this.colors.red(head))
  }
}

/** The OS username for audit attribution, or null if it cannot be read (a sandbox). */
function safeOsUser(): string | null {
  try {
    return userInfo().username || null
  } catch {
    return null
  }
}
