import { BaseSchema } from '@adonisjs/lucid/schema'

/** Rentals. Money columns are santimat; price_breakdown records the calc. */
export default class extends BaseSchema {
  protected tableName = 'bookings'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.db.rawQuery('gen_random_uuid()').knexQuery)
      table.string('reference').notNullable().unique()
      table
        .uuid('customer_id')
        .notNullable()
        .references('id')
        .inTable('customers')
        .onDelete('RESTRICT')
      table
        .uuid('vehicle_id')
        .notNullable()
        .references('id')
        .inTable('vehicles')
        .onDelete('RESTRICT')
      table
        .uuid('pickup_location_id')
        .nullable()
        .references('id')
        .inTable('rental_locations')
        .onDelete('SET NULL')
      table.timestamp('pickup_at', { useTz: true }).notNullable()
      table
        .uuid('dropoff_location_id')
        .nullable()
        .references('id')
        .inTable('rental_locations')
        .onDelete('SET NULL')
      table.timestamp('dropoff_at', { useTz: true }).notNullable()
      table.string('status').notNullable().defaultTo('quote')
      table.jsonb('price_breakdown').nullable()
      table.integer('deposit_held').notNullable().defaultTo(0)
      table.jsonb('extras').notNullable().defaultTo('[]')
      table.integer('total_amount').notNullable().defaultTo(0)
      table.string('currency').notNullable().defaultTo('MAD')
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.index(['vehicle_id', 'status'])
      table.index(['status'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
