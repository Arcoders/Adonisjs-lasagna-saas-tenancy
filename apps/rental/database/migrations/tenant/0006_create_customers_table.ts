import { BaseSchema } from '@adonisjs/lucid/schema'
import { encryptedColumnCheckSql } from '@adonisjs-lasagna/crypto'

/**
 * Renters. `cin`, `driver_license`, `passport` are crypto `@encrypted` fields:
 * enc_v2 ciphertext at rest, guarded by the DB-level `encryptedColumnCheckSql`
 * CHECK — the fail-closed backstop that rejects a raw / query-builder /
 * `*Quietly` plaintext write the model hooks can't see. The `*_index` columns
 * hold their `@searchable` blind-index HMACs.
 */
export default class extends BaseSchema {
  protected tableName = 'customers'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.db.rawQuery('gen_random_uuid()').knexQuery)
      table.string('full_name').notNullable()
      table.string('email').nullable()
      table.string('phone').nullable()

      // enc_v2 ciphertext at rest, never plaintext (guarded by the CHECKs below).
      table.text('cin').nullable()
      table.text('driver_license').nullable()
      table.text('passport').nullable()

      table.string('cin_index').nullable().index()
      table.string('driver_license_index').nullable().index()
      table.string('passport_index').nullable().index()

      table.string('address').nullable()
      table.date('date_of_birth').nullable()
      table.string('nationality').nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
    })

    // safe-sql: table/column are fixed literals; the helper validates identifiers.
    this.schema.raw(encryptedColumnCheckSql(this.tableName, 'cin'))
    this.schema.raw(encryptedColumnCheckSql(this.tableName, 'driver_license'))
    this.schema.raw(encryptedColumnCheckSql(this.tableName, 'passport'))
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
