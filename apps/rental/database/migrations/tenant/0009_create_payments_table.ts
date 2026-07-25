import { BaseSchema } from '@adonisjs/lucid/schema'

/** Renter payments against a booking (domain money, not the SaaS billing). */
export default class extends BaseSchema {
  protected tableName = 'payments'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.db.rawQuery('gen_random_uuid()').knexQuery)
      table
        .uuid('booking_id')
        .notNullable()
        .references('id')
        .inTable('bookings')
        .onDelete('CASCADE')
      table.integer('amount').notNullable()
      table.string('currency').notNullable().defaultTo('MAD')
      table.string('method').notNullable().defaultTo('cash')
      table.string('status').notNullable().defaultTo('pending')
      table.string('reference').nullable()
      table.timestamp('paid_at', { useTz: true }).nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.index(['booking_id'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
