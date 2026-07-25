import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Token storage for the backoffice (operator) guard. Tenant-realm tokens do NOT
 * share this table: they live in each company schema's own `auth_access_tokens`
 * (database/migrations/tenant/0002), which is what keeps the realms separate at
 * rest.
 */
export default class extends BaseSchema {
  protected tableName = 'auth_access_tokens'

  async up() {
    this.schema.withSchema('backoffice').createTable(this.tableName, (table) => {
      table.increments('id').primary()
      table
        .uuid('tokenable_id')
        .notNullable()
        .references('id')
        .inTable('backoffice.backoffice_users')
        .onDelete('CASCADE')
      table.string('type').notNullable()
      table.string('name').nullable()
      table.string('hash').notNullable()
      table.text('abilities').notNullable()
      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable()
      table.timestamp('last_used_at', { useTz: true }).nullable()
      table.timestamp('expires_at', { useTz: true }).nullable()
    })
  }

  async down() {
    this.schema.withSchema('backoffice').dropTable(this.tableName)
  }
}
