import { BaseSchema } from '@adonisjs/lucid/schema'

/** Per-vehicle maintenance history. `cost` is santimat. */
export default class extends BaseSchema {
  protected tableName = 'maintenance_records'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.db.rawQuery('gen_random_uuid()').knexQuery)
      table
        .uuid('vehicle_id')
        .notNullable()
        .references('id')
        .inTable('vehicles')
        .onDelete('CASCADE')
      table.string('type').notNullable().defaultTo('service')
      table.integer('cost').notNullable().defaultTo(0)
      table.integer('odometer').notNullable().defaultTo(0)
      table.timestamp('performed_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.text('notes').nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.index(['vehicle_id'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
