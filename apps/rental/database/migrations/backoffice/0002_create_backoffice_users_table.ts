import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Operator accounts for the backoffice auth realm. One fleet-wide table in the
 * backoffice schema; company staff never live here (they get their own `users`
 * table inside each company schema, see database/migrations/tenant/0001).
 */
export default class extends BaseSchema {
  protected tableName = 'backoffice_users'

  async up() {
    this.schema.withSchema('backoffice').createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.db.rawQuery('gen_random_uuid()').knexQuery)
      table.string('email').notNullable().unique()
      table.string('password').notNullable()
      table.string('full_name').nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
    })
  }

  async down() {
    this.schema.withSchema('backoffice').dropTable(this.tableName)
  }
}
