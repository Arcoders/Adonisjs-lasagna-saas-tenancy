import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import db from '@adonisjs/lucid/services/db'
import { getConfig } from '../config.js'
import { SECRET_AT_REST_COLUMNS, SECRET_CLASS, writeSecret } from '../utils/secret_at_rest.js'
import { classifySecretRotation } from '../utils/secrets_rotation.js'

/**
 * Secret migration / rotation tooling. Stored secrets (webhook signing secrets,
 * SSO client secrets) are encrypted at rest, and reads now fail closed and are
 * domain-separated per class. This command brings every stored value to the
 * canonical `(current APP_KEY, per-class context)` form. It covers two axes:
 *
 *   - APP_KEY rotation. Set OLD_APP_KEY to the previous key:
 *       OLD_APP_KEY=<previous key> node ace tenant:secrets:reencrypt
 *     Each value that decrypts under the old key is re-encrypted under the
 *     current key.
 *   - Context migration / encrypt-at-rest. Run with OLD_APP_KEY unset:
 *       node ace tenant:secrets:reencrypt
 *     Values still encrypted under the legacy shared default context, and any
 *     plaintext-era values, are (re-)encrypted under their per-class context.
 *
 * Both axes are handled in one idempotent, resumable pass: a value already at the
 * target is skipped. The old key comes from the environment, never argv, so it
 * stays out of shell history and process listings.
 *
 * Satellite tables are matched by name in the backoffice schema (the work list is
 * single-sourced from SECRET_AT_REST_COLUMNS), so the command covers
 * `tenant_sso_configs` without core importing the sso package; an uninstalled
 * satellite is simply skipped.
 */
export default class TenantSecretsReencrypt extends BaseCommand {
  static readonly commandName = 'tenant:secrets:reencrypt'
  static readonly description =
    'Migrate/rotate stored secrets to the current APP_KEY and per-class context (reads any previous key from OLD_APP_KEY)'
  static readonly options: CommandOptions = { startApp: true }

  @flags.boolean({
    flagName: 'dry-run',
    description: 'Report what would be re-encrypted without writing',
    default: false,
  })
  declare dryRun: boolean

  async run() {
    const currentKey = process.env.APP_KEY
    if (!currentKey) {
      this.logger.error('APP_KEY is not set; cannot re-encrypt secrets.')
      this.exitCode = 1
      return
    }

    const rawOldKey = process.env.OLD_APP_KEY
    // OLD_APP_KEY is optional. Unset (or equal to the current key) means a
    // context-only migration: there is no separate key to recover from, so the
    // classifier uses the current key for the old-key attempts.
    const oldKey = rawOldKey && rawOldKey !== currentKey ? rawOldKey : currentKey
    const mode =
      oldKey === currentKey ? 'context migration' : 'APP_KEY rotation + context migration'
    this.logger.info(`Mode: ${mode}.`)

    const { backofficeConnectionName, backofficeSchemaName } = getConfig()
    const conn = db.connection(backofficeConnectionName)

    let rotated = 0
    let current = 0
    let failed = 0

    for (const { table, column, cls } of SECRET_AT_REST_COLUMNS) {
      const exists = await conn.rawQuery(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
        [backofficeSchemaName, table]
      )
      if ((exists.rows ?? []).length === 0) {
        this.logger.info(`${table}: not installed, skipped`)
        continue
      }

      const targetContext = SECRET_CLASS[cls]
      const rows: Array<{ id: string; value: string }> = await conn
        .query()
        .from(table)
        .select('id', `${column} as value`)
        .whereNotNull(column)

      for (const row of rows) {
        const decision = classifySecretRotation(row.value, oldKey, currentKey, targetContext)
        if (decision.action === 'current') {
          current++ // already at (current key, target context): idempotent skip
          continue
        }
        if (decision.action === 'failed') {
          failed++
          this.logger.error(
            `${table}.${column} id=${row.id}: not recoverable under the current or old APP_KEY`
          )
          continue
        }

        if (!this.dryRun) {
          await conn
            .query()
            .from(table)
            .where('id', row.id)
            .update({ [column]: writeSecret(decision.plaintext, cls) })
        }
        rotated++
      }
      this.logger.info(`${table}.${column}: processed ${rows.length} row(s)`)
    }

    const verb = this.dryRun ? 'would re-encrypt' : 're-encrypted'
    this.logger.info(`Summary: ${verb} ${rotated}, already current ${current}, failed ${failed}`)
    if (failed > 0) {
      this.logger.error(
        'Some secrets are not recoverable under the current or old APP_KEY — they were ' +
          'encrypted under a different APP_KEY generation and must be re-entered by the ' +
          'tenant or restored from backup.'
      )
      this.exitCode = 1
      return
    }
    this.logger.success(this.dryRun ? 'Dry run complete' : 'Secrets migrated')
  }
}
