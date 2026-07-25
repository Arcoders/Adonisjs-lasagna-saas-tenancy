import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Fleet vehicles. `make_id`/`model_id` reference the central catalog and are
 * plain integers (no cross-connection FK); `make_name`/`model_name` are
 * denormalised for display. `category_id`/`location_id` are in-schema FKs.
 */
export default class extends BaseSchema {
  protected tableName = 'vehicles'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.db.rawQuery('gen_random_uuid()').knexQuery)
      table.string('plate').notNullable().unique()
      table.integer('make_id').notNullable()
      table.integer('model_id').notNullable()
      table.string('make_name').notNullable()
      table.string('model_name').notNullable()
      table.integer('year').notNullable()
      table
        .uuid('category_id')
        .notNullable()
        .references('id')
        .inTable('vehicle_categories')
        .onDelete('RESTRICT')
      table
        .uuid('location_id')
        .nullable()
        .references('id')
        .inTable('rental_locations')
        .onDelete('SET NULL')
      table.string('status').notNullable().defaultTo('available')
      table.integer('mileage').notNullable().defaultTo(0)
      table.string('fuel').notNullable().defaultTo('petrol')
      table.string('transmission').notNullable().defaultTo('manual')
      table.string('color').nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.index(['status'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
