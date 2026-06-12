import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import db from '@adonisjs/lucid/services/db'
import { getConfig } from '../config.js'
import { encrypt, decryptWithAppKey, isEncrypted } from '../utils/crypto.js'

/**
 * APP_KEY rotation tooling (audit P3-3). Stored secrets (webhook signing
 * secrets, SSO client secrets) are encrypted with `sha256(APP_KEY)`, so
 * rotating APP_KEY silently turns every one of them into a permanent
 * decryption failure. This command makes rotation a supported operation:
 *
 *   OLD_APP_KEY=<previous key> node ace tenant:secrets:reencrypt
 *
 * For every known encrypted column it decrypts each `enc_v1:` value with the
 * OLD key and re-encrypts it with the CURRENT `APP_KEY`. Values that already
 * decrypt with the current key are skipped (the command is idempotent and
 * resumable). The old key comes from the environment, never argv, so it stays
 * out of shell history and process listings.
 *
 * Satellite tables are matched by name in the backoffice schema, so the
 * command covers `tenant_sso_configs` (the sso package's table) without core
 * importing the package; an uninstalled satellite is simply skipped.
 */
const ENCRYPTED_COLUMNS: Array<{ table: string; column: string }> = [
  { table: 'tenant_webhooks', column: 'secret' },
  { table: 'tenant_sso_configs', column: 'client_secret' },
]

export default class TenantSecretsReencrypt extends BaseCommand {
  static readonly commandName = 'tenant:secrets:reencrypt'
  static readonly description =
    'Re-encrypt stored secrets after an APP_KEY rotation (reads the previous key from OLD_APP_KEY)'
  static readonly options: CommandOptions = { startApp: true }

  @flags.boolean({
    flagName: 'dry-run',
    description: 'Report what would be re-encrypted without writing',
    default: false,
  })
  declare dryRun: boolean

  async run() {
    const oldKey = process.env.OLD_APP_KEY
    if (!oldKey) {
      this.logger.error(
        'Set OLD_APP_KEY to the previous APP_KEY (env only — never a flag). ' +
          'Current APP_KEY must already hold the NEW key.'
      )
      this.exitCode = 1
      return
    }
    if (oldKey === process.env.APP_KEY) {
      this.logger.error('OLD_APP_KEY equals the current APP_KEY — nothing to rotate.')
      this.exitCode = 1
      return
    }

    const { backofficeConnectionName, backofficeSchemaName } = getConfig()
    const conn = db.connection(backofficeConnectionName)

    let rotated = 0
    let current = 0
    let failed = 0

    for (const { table, column } of ENCRYPTED_COLUMNS) {
      const exists = await conn.rawQuery(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
        [backofficeSchemaName, table]
      )
      if ((exists.rows ?? []).length === 0) {
        this.logger.info(`${table}: not installed, skipped`)
        continue
      }

      const rows: Array<{ id: string; value: string }> = await conn
        .query()
        .from(table)
        .select('id', `${column} as value`)
        .whereNotNull(column)

      for (const row of rows) {
        if (!isEncrypted(row.value)) continue // plaintext-era row: nothing key-bound to rotate

        // Try the old key first; if it fails, check whether the value already
        // uses the current key (idempotent re-runs / partially rotated tables).
        let plaintext: string
        try {
          plaintext = decryptWithAppKey(row.value, oldKey)
        } catch {
          try {
            decryptWithAppKey(row.value, process.env.APP_KEY ?? '')
            current++
            continue
          } catch {
            failed++
            this.logger.error(`${table}.${column} id=${row.id}: decrypts with NEITHER key`)
            continue
          }
        }

        if (!this.dryRun) {
          await conn
            .query()
            .from(table)
            .where('id', row.id)
            .update({ [column]: encrypt(plaintext) })
        }
        rotated++
      }
      this.logger.info(`${table}.${column}: processed ${rows.length} row(s)`)
    }

    const verb = this.dryRun ? 'would re-encrypt' : 're-encrypted'
    this.logger.info(`Summary: ${verb} ${rotated}, already current ${current}, failed ${failed}`)
    if (failed > 0) {
      this.logger.error(
        'Some secrets decrypt with neither key — they were encrypted under a different ' +
          'APP_KEY generation and must be re-entered by the tenant or restored from backup.'
      )
      this.exitCode = 1
      return
    }
    this.logger.success(this.dryRun ? 'Dry run complete' : 'Secrets re-encrypted')
  }
}
