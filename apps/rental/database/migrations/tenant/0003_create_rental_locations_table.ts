import { BaseSchema } from '@adonisjs/lucid/schema'

/** Company branches. Runs once inside every `tenant_<uuid>` schema. */
export default class extends BaseSchema {
  protected tableName = 'rental_locations'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.db.rawQuery('gen_random_uuid()').knexQuery)
      table.string('name').notNullable()
      table.string('type').notNullable().defaultTo('city')
      table.string('address').nullable()
      table.string('city').notNullable()
      table.string('timezone').notNullable().defaultTo('Africa/Casablanca')
      table.string('phone').nullable()
      table.integer('open_hour').notNullable().defaultTo(8)
      table.integer('close_hour').notNullable().defaultTo(20)
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
