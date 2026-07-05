import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import AiAuditWriter from '../services/ai_audit_writer.js'

/**
 * Re-walk the append-only AI audit hash chain and report the first break. The DB
 * triggers already reject UPDATE/DELETE/TRUNCATE; this catches tampering that got
 * PAST them (a superuser who disabled the triggers, rewrote a row, and re-enabled
 * them): the recomputed checksum no longer matches, a deletion leaves a `seq` gap,
 * or the prev-link is broken. Exits 1 on the first break so it slots into a cron or
 * a post-incident gate: `node ace tenant:ai:audit:verify --json || alert`.
 */
export default class AiAuditVerify extends BaseCommand {
  static readonly commandName = 'tenant:ai:audit:verify'
  static readonly description =
    'Verify the append-only AI audit hash chain and report the first tamper (checksum / gap / prev-link)'
  static readonly options: CommandOptions = { startApp: true }

  @flags.string({
    flagName: 'tenant',
    description: 'Verify a single tenant (uuid); omit to verify every tenant',
  })
  declare tenant?: string

  @flags.boolean({ flagName: 'json', default: false, description: 'Emit a JSON result' })
  declare json: boolean

  async run() {
    const ai = getConfig().ai
    if (!ai || ai.audit?.enabled === false) {
      this.logger.log('AI audit is disabled (config.ai.audit.enabled = false); nothing to verify.')
      return
    }

    const writer = await this.app.container.make(AiAuditWriter)
    const result = await writer.verify(this.tenant)

    if (this.json) {
      this.logger.log(JSON.stringify(result, null, 2))
    } else if (result.ok) {
      this.logger.log(
        this.colors.green(`OK  ${result.checked} audit row(s) verified; the chain is intact.`)
      )
    } else {
      const brk = result.break!
      this.logger.log(
        this.colors.red(
          `BROKEN  tenant ${brk.tenantId} seq ${brk.seq}: ${brk.reason} ` +
            `(verified ${result.checked} row(s) before the break).`
        )
      )
    }
    this.exitCode = result.ok ? 0 : 1
  }
}
