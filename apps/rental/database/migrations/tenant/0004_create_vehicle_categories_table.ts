import { BaseSchema } from '@adonisjs/lucid/schema'

/** Pricing tiers. Money columns are santimat (MAD × 100). */
export default class extends BaseSchema {
  protected tableName = 'vehicle_categories'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.db.rawQuery('gen_random_uuid()').knexQuery)
      table.string('name').notNullable()
      table.string('code').notNullable()
      table.integer('daily_rate').notNullable().defaultTo(0)
      table.integer('deposit_amount').notNullable().defaultTo(0)
      table.jsonb('extras').notNullable().defaultTo('[]')
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.unique(['code'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
