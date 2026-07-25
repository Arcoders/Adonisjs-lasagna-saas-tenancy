import { BaseSchema } from '@adonisjs/lucid/schema'

/** VAT invoices, one per booking. Money is santimat; vat is 20% TVA. */
export default class extends BaseSchema {
  protected tableName = 'invoices'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.db.rawQuery('gen_random_uuid()').knexQuery)
      table
        .uuid('booking_id')
        .notNullable()
        .references('id')
        .inTable('bookings')
        .onDelete('CASCADE')
      table.string('number').notNullable().unique()
      table.jsonb('lines').notNullable().defaultTo('[]')
      table.integer('subtotal').notNullable().defaultTo(0)
      table.integer('vat').notNullable().defaultTo(0)
      table.integer('total').notNullable().defaultTo(0)
      table.string('currency').notNullable().defaultTo('MAD')
      table.timestamp('issued_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
