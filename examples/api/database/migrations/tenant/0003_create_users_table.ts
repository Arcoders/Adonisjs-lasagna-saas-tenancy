import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Tenant-scoped users for the tenant auth realm. Runs against the per-tenant
 * connection, so the table is created once inside every `tenant_<uuid>`
 * schema and the same email can exist independently in two tenants. Operators
 * never live here; they have `backoffice.backoffice_users`.
 */
export default class extends BaseSchema {
  protected tableName = 'users'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').primary()
      table.string('email').notNullable().unique()
      table.string('password').notNullable()
      table.string('full_name').nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
