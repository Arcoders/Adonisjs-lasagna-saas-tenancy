import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The shared car-make catalog, in the central `public` schema. Runs with
 * `node ace migration:run --connection=public`. Cross-company: every company's
 * fleet selects makes from this one table.
 */
export default class extends BaseSchema {
  protected tableName = 'car_makes'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').primary()
      table.string('name').notNullable()
      table.string('slug').notNullable().unique()
      table.string('country').nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
