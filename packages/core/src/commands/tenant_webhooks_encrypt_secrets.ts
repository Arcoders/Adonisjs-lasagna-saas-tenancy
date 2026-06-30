import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import db from '@adonisjs/lucid/services/db'
import { getConfig } from '../config.js'
import { isEncrypted } from '../utils/crypto.js'
import { writeSecret } from '../utils/secret_at_rest.js'

/**
 * One-time upgrade step for PLAINTEXT webhook secrets. Webhook delivery fails
 * closed on a stored secret that is not ciphertext (it used to sign with raw
 * column bytes for a non-encrypted value). Hosts that wrote plaintext secrets,
 * for example by following the demo controller before it encrypted at the write
 * boundary, run this once to encrypt them at rest under the webhook secret class.
 *
 * Idempotent: a secret that already carries a ciphertext prefix is left
 * untouched, so the command is safe to re-run and to schedule defensively. Use
 * `--dry-run` to see the counts first.
 *
 * Scope note: this only encrypts PLAINTEXT values. For the full migration that
 * also re-encrypts already-encrypted secrets under their per-class context (the
 * domain-separation upgrade), run `tenant:secrets:reencrypt`, which supersedes
 * this command.
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
        alreadyEncrypted++ // already ciphertext: idempotent skip (see scope note)
        continue
      }
      if (!this.dryRun) {
        await conn
          .query()
          .from('tenant_webhooks')
          .where('id', row.id)
          .update({ secret: writeSecret(row.secret, 'webhookSecret') })
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
