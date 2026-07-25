import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The shared car-model catalog, in the central `public` schema. `make_id`
 * references `car_makes` in the same central connection.
 */
export default class extends BaseSchema {
  protected tableName = 'car_models'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').primary()
      table
        .integer('make_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('car_makes')
        .onDelete('CASCADE')
      table.string('name').notNullable()
      table.string('body_type').nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.unique(['make_id', 'name'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
