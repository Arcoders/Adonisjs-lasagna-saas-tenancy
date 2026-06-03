import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Per-tenant `notes` table for schema-pg + database-pg. Run by
 * `driver.migrate(tenant, {})` into each tenant's schema/database. No
 * tenant_id column: isolation is the schema/database boundary itself.
 */
export default class extends BaseSchema {
  protected tableName = 'notes'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table.string('title', 255).notNullable()
      table.string('body', 1024).nullable()
      table.timestamp('created_at', { useTz: true }).defaultTo(this.now())
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
