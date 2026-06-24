import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import db from '@adonisjs/lucid/services/db'
import { getConfig } from '../config.js'
import { encrypt, isEncrypted } from '../utils/crypto.js'

/**
 * One-time upgrade step. Webhook delivery now fails closed on a stored secret
 * that is not `enc_v1` ciphertext (it used to sign with raw column bytes for a
 * non-encrypted value). Hosts that wrote plaintext secrets — for example by
 * following the demo controller before it encrypted at the write boundary —
 * must run this once to encrypt them at rest, otherwise their deliveries start
 * failing after the upgrade.
 *
 * Idempotent: a secret that is already `enc_v1` is left untouched, so the
 * command is safe to re-run and to schedule defensively. Use `--dry-run` to see
 * the counts first.
 */
export default class TenantWebhooksEncryptSecrets extends BaseCommand {
  static readonly commandName = 'tenant:webhooks:encrypt-secrets'
  static readonly description =
    'Encrypt any plaintext webhook signing secrets at rest (one-time upgrade; idempotent)'
  static readonly options: CommandOptions = { startApp: true }

  @flags.boolean({
    flagName: 'dry-run',
    description: 'Report what would be encrypted without writing',
    default: false,
  })
  declare dryRun: boolean

  async run() {
    const { backofficeConnectionName, backofficeSchemaName } = getConfig()
    const conn = db.connection(backofficeConnectionName)

    const exists = await conn.rawQuery(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
      [backofficeSchemaName, 'tenant_webhooks']
    )
    if ((exists.rows ?? []).length === 0) {
      this.logger.info('tenant_webhooks: not installed, nothing to do')
      return
    }

    const rows: Array<{ id: string; secret: string | null }> = await conn
      .query()
      .from('tenant_webhooks')
      .select('id', 'secret')
      .whereNotNull('secret')

    let encrypted = 0
    let alreadyEncrypted = 0

    for (const row of rows) {
      if (row.secret === null) continue
      if (isEncrypted(row.secret)) {
        alreadyEncrypted++ // already enc_v1: idempotent skip
        continue
      }
      if (!this.dryRun) {
        await conn
          .query()
          .from('tenant_webhooks')
          .where('id', row.id)
          .update({ secret: encrypt(row.secret) })
      }
      encrypted++
    }

    const verb = this.dryRun ? 'would encrypt' : 'encrypted'
    this.logger.info(
      `Summary: ${verb} ${encrypted} plaintext secret(s), ${alreadyEncrypted} already encrypted`
    )
    this.logger.success(this.dryRun ? 'Dry run complete' : 'Webhook secrets encrypted at rest')
  }
}
