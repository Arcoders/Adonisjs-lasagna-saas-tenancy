import { BaseSchema } from '@adonisjs/lucid/schema'

/** Signed contracts, one per booking. */
export default class extends BaseSchema {
  protected tableName = 'rental_agreements'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.db.rawQuery('gen_random_uuid()').knexQuery)
      table
        .uuid('booking_id')
        .notNullable()
        .references('id')
        .inTable('bookings')
        .onDelete('CASCADE')
      table.text('terms').nullable()
      table.timestamp('signed_at', { useTz: true }).nullable()
      table.string('signature_ref').nullable()
      table.string('pdf_ref').nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
