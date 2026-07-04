import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { resolveTenantRepository } from '@adonisjs-lasagna/saas-tenancy/services'
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import RekekService, { type RekekTenantSummary } from '../services/rekek_service.js'

/**
 * KEK rotation (I8, §6.7): re-wrap every live DEK under the current KEK generation.
 * Rotating the KEK does NOT re-encrypt field values — it unwraps each DEK under the
 * old KEK and re-wraps it under the new one, so the operation is O(number of DEKs),
 * not O(number of field values), and the data ciphertext keeps decrypting.
 *
 *   tenant:crypto:rekek                 # re-wrap every tenant's DEKs
 *   tenant:crypto:rekek --tenant <uuid> # a single tenant
 *   tenant:crypto:rekek --dry-run       # classify + report, write nothing
 *
 * Under the env KeyProvider a KEK rotation IS an APP_KEY rotation: set the previous
 * key in `OLD_APP_KEY` and the new one in `APP_KEY`, run this, then drop
 * `OLD_APP_KEY` once the summary reports zero rows still on the old generation. The
 * old key comes from the environment, never argv, so it stays out of shell history.
 * A KMS/Vault provider retains its prior key versions itself, so no env is needed.
 *
 * Idempotent and resumable: a re-run skips rows already at the current `kek_id`. A
 * DEK that unwraps under no KEK generation the provider holds is reported `failed`
 * (its data must be restored from backup or re-entered); any failure exits non-zero.
 */
export default class TenantCryptoRekek extends BaseCommand {
  static readonly commandName = 'tenant:crypto:rekek'
  static readonly description =
    'Re-wrap every DEK under the current KEK generation (KEK rotation; never re-encrypts field data)'
  static readonly options: CommandOptions = { startApp: true }

  @flags.string({
    flagName: 'tenant',
    description: 'Rotate a single tenant (uuid); omit to rotate every tenant',
  })
  declare tenant?: string

  @flags.boolean({
    flagName: 'dry-run',
    default: false,
    description: 'Classify and report what would be re-wrapped, writing nothing',
  })
  declare dryRun: boolean

  @flags.boolean({ flagName: 'json', default: false, description: 'Emit a JSON result' })
  declare json: boolean

  async run() {
    if (!getConfig().crypto) {
      this.logger.error('config.crypto is not configured; there are no DEKs to re-wrap.')
      this.exitCode = 1
      return
    }

    const rekek = await this.app.container.make(RekekService)
    const repo = await resolveTenantRepository()

    const results: Array<{ tenantId: string; summary: RekekTenantSummary }> = []

    if (this.tenant) {
      let tenant: TenantModelContract
      try {
        tenant = await repo.findByIdOrFail(this.tenant)
      } catch (error: any) {
        this.logger.error(`Tenant not found: ${error.message}`)
        this.exitCode = 1
        return
      }
      results.push({ tenantId: tenant.id, summary: await this.#rekekOne(rekek, tenant) })
    } else {
      // Cursor-paginated iteration: memory-safe for large tenant counts.
      await repo.each(async (tenant) => {
        results.push({ tenantId: tenant.id, summary: await this.#rekekOne(rekek, tenant) })
      })
    }

    this.#report(results)
  }

  /** Rotate one tenant inside its tenancy scope so the store's ContextSeal + connection resolve. */
  async #rekekOne(rekek: RekekService, tenant: TenantModelContract): Promise<RekekTenantSummary> {
    return tenancy.run(tenant, () => rekek.rekekTenant(tenant, { dryRun: this.dryRun }))
  }

  /** Print the per-tenant + total summary; any failed DEK is a non-zero exit. */
  #report(results: Array<{ tenantId: string; summary: RekekTenantSummary }>): void {
    const totals = results.reduce(
      (acc, { summary }) => ({
        scanned: acc.scanned + summary.scanned,
        current: acc.current + summary.current,
        rotated: acc.rotated + summary.rotated,
        failed: acc.failed + summary.failed,
      }),
      { scanned: 0, current: 0, rotated: 0, failed: 0 }
    )

    if (this.json) {
      this.logger.log(JSON.stringify({ dryRun: this.dryRun, tenants: results, totals }, null, 2))
    } else {
      for (const { tenantId, summary } of results) {
        if (summary.scanned === 0) continue // quietly skip tenants with no DEKs
        const line =
          `${tenantId}: scanned ${summary.scanned}, ` +
          `${this.dryRun ? 'would re-wrap' : 're-wrapped'} ${summary.rotated}, ` +
          `already current ${summary.current}, failed ${summary.failed}`
        this.logger.log(summary.failed > 0 ? this.colors.red(line) : this.colors.dim(line))
        for (const f of summary.failures) {
          this.logger.log(
            this.colors.red(
              `  FAILED ${f.subjectId}/${f.category} (id=${f.id}, kek_id=${f.kekId}): ${f.reason}`
            )
          )
        }
      }
      const verb = this.dryRun ? 'would re-wrap' : 're-wrapped'
      const head =
        `Summary: ${verb} ${totals.rotated}, already current ${totals.current}, ` +
        `failed ${totals.failed} (across ${results.length} tenant(s))`
      this.logger.log(totals.failed > 0 ? this.colors.red(head) : this.colors.green(head))
    }

    if (totals.failed > 0) {
      this.logger.error(
        'Some DEKs unwrap under no known KEK generation — they were wrapped under a ' +
          'different KEK/APP_KEY generation and must be restored from backup or re-entered. ' +
          'Set OLD_APP_KEY to the previous key (env provider) and re-run.'
      )
      this.exitCode = 1
    }
  }
}
