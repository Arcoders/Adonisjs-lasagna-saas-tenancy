import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Shared `notes` table for rowscope-pg, in the central (public) schema. One
 * table for all tenants, separated by the `tenant_id` column that
 * `withTenantScope` filters on. Run centrally (once) against the `public`
 * connection by the harness, not per tenant.
 */
export default class extends BaseSchema {
  protected tableName = 'notes'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table.string('title', 255).notNullable()
      table.string('body', 1024).nullable()
      table.string('tenant_id', 64).notNullable().index()
      table.timestamp('created_at', { useTz: true }).defaultTo(this.now())
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
