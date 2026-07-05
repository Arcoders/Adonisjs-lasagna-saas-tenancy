import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { resolveTenantRepository } from '@adonisjs-lasagna/saas-tenancy/services'
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import CryptoService, { type ShredResult } from '../services/crypto_service.js'
import CryptoException from '../exceptions/crypto_exception.js'

/**
 * Crypto-shred a `(subject × category)` (I6, §6.6): the O(1) erasure that destroys
 * the wrapped DEK, making every field ciphertext and vault blob under it (and their
 * backups) irrecoverable at once. Operator-privileged and gated:
 *
 *   tenant:crypto:shred --tenant <uuid> --subject <id> --category <key>
 *   tenant:crypto:shred ... --dry-run   # check the gate + preconditions, destroy nothing
 *
 * The erasure is REFUSED (I7) when governance's `legalBasis` marks the category
 * non-erasable (a `legal-obligation` in retention), when the erasability resolver is
 * absent, or when no WORM ledger is wired (an irreversible erasure is never run
 * unaudited). A real run requires `--force` (it cannot be undone) and is recorded in
 * the two-phase WORM ledger. Idempotent: re-shredding is a no-op success.
 */
export default class TenantCryptoShred extends BaseCommand {
  static readonly commandName = 'tenant:crypto:shred'
  static readonly description =
    'Crypto-shred a (subject × category): destroy its DEK so all ciphertext under it is irrecoverable (gated by governance)'
  static readonly options: CommandOptions = { startApp: true }

  @flags.string({ flagName: 'tenant', description: 'Tenant id (uuid) (required)' })
  declare tenant?: string

  @flags.string({ flagName: 'subject', description: 'Data-subject id to shred (required)' })
  declare subject?: string

  @flags.string({
    flagName: 'category',
    description: 'Processing category key to shred (required)',
  })
  declare category?: string

  @flags.boolean({
    flagName: 'dry-run',
    default: false,
    description: 'Check the governance gate + preconditions and report, destroying nothing',
  })
  declare dryRun: boolean

  @flags.boolean({
    flagName: 'force',
    alias: 'y',
    default: false,
    description: 'Required for a real shred (it is irreversible; skips the confirmation)',
  })
  declare force: boolean

  @flags.boolean({ flagName: 'json', default: false, description: 'Emit a JSON result' })
  declare json: boolean

  async run() {
    if (!getConfig().crypto) {
      this.logger.error('config.crypto is not configured; there is nothing to shred.')
      this.exitCode = 1
      return
    }
    if (!this.tenant || !this.subject || !this.category) {
      this.logger.error('--tenant <uuid>, --subject <id> and --category <key> are all required.')
      this.exitCode = 1
      return
    }

    const repo = await resolveTenantRepository()
    let tenant: TenantModelContract
    try {
      tenant = await repo.findByIdOrFail(this.tenant)
    } catch (error: unknown) {
      this.logger.error(
        `Tenant not found: ${error instanceof Error ? error.message : String(error)}`
      )
      this.exitCode = 1
      return
    }

    const crypto = await this.app.container.make(CryptoService)
    const subject = this.subject
    const category = this.category

    // A real shred is irreversible: require --force or an interactive confirmation.
    if (!this.dryRun && !this.force) {
      const ok = await this.prompt.confirm(
        `Crypto-shred subject '${subject}' / category '${category}' for tenant ${tenant.id}? ` +
          `This destroys the DEK and CANNOT be undone.`
      )
      if (!ok) {
        this.logger.info('Aborted.')
        return
      }
    }

    let result: ShredResult
    try {
      result = await tenancy.run(tenant, () =>
        crypto.shred(tenant, subject, category, { dryRun: this.dryRun })
      )
    } catch (error) {
      // A refusal (legal hold / governance absent / unaudited) is the fail-closed
      // path (I7): report it clearly and exit non-zero rather than throwing a stack.
      const code = error instanceof CryptoException ? error.code : 'error'
      const message = error instanceof Error ? error.message : String(error)
      if (this.json) {
        this.logger.log(
          JSON.stringify({ tenantId: tenant.id, subject, category, refused: code, message })
        )
      } else {
        this.logger.error(`REFUSED [${code}]: ${message}`)
      }
      this.exitCode = 1
      return
    }

    this.#report(tenant.id, subject, category, result)
  }

  #report(tenantId: string, subject: string, category: string, result: ShredResult): void {
    if (this.json) {
      this.logger.log(JSON.stringify({ tenantId, subject, category, ...result }))
      return
    }
    const target = `subject '${subject}' / category '${category}' (tenant ${tenantId})`
    if (result.dryRun) {
      if (result.alreadyShredded) {
        this.logger.log(
          this.colors.dim(
            `[dry-run] ${target}: no live DEK (already shredded or never provisioned).`
          )
        )
      } else {
        this.logger.log(
          this.colors.yellow(
            `[dry-run] ${target}: a live DEK exists and IS erasable — a real run would shred it.`
          )
        )
      }
      return
    }
    if (result.alreadyShredded) {
      this.logger.log(this.colors.dim(`${target}: no live DEK to shred (idempotent no-op).`))
    } else {
      this.logger.log(
        this.colors.green(
          `${target}: SHREDDED — the DEK is destroyed; all ciphertext under it is now irrecoverable.`
        )
      )
    }
  }
}
