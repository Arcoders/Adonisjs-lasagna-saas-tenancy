import { BaseSchema } from '@adonisjs/lucid/schema'
import { encryptedColumnCheckSql } from '@adonisjs-lasagna/crypto'

/**
 * Tenant-scoped `secure_notes` table backing the crypto satellite e2e. Runs against
 * the per-tenant connection (`tenant_<uuid>`, searchPath = that schema), so the bare
 * name lands in `tenant_<uuid>.secure_notes`.
 *
 * `secret` is a crypto `@encrypted` field (category `demo-secret`), stored as an
 * enc_v2 ciphertext; `secret_index` is its `@searchable` blind index (a keyed HMAC).
 * The DB-level CHECK from `encryptedColumnCheckSql` is the fail-closed backstop
 * (crypto §4 I3, invariant-3): it REJECTS a raw/query-builder/`*Quietly` plaintext
 * write to `secret` — the T5 bypass the model hooks cannot see — so a leak cannot
 * reach disk even outside the model instance path.
 */
export default class extends BaseSchema {
  protected tableName = 'secure_notes'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.db.rawQuery('gen_random_uuid()').knexQuery)
      // The data-subject key (e.g. a renter reference); the per-(subject × category)
      // DEK is derived from it, and a crypto-shred targets it.
      table.string('subject').notNullable()
      // enc_v2 ciphertext at rest — never plaintext (guarded by the CHECK below).
      table.text('secret').nullable()
      // The keyed-HMAC blind index for equality search; survives a shred (T14).
      table.string('secret_index').nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
    })

    // The fail-closed ciphertext CHECK on the encrypted column. safe-sql: table/column
    // are fixed literals from this migration, and the helper validates the identifiers.
    this.schema.raw(encryptedColumnCheckSql(this.tableName, 'secret'))
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
